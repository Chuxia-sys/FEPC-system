// =============================================================
// Intelligent Conflict Detection & Auto-Rescheduling Engine
// =============================================================
// This module implements the full conflict lifecycle:
//   Phase 1: Detection (5 conflict types)
//   Phase 2: Intelligent Reassignment (3-tier scoring)
//   Phase 3: Validation & Cascade Prevention
//
// All operations use the Firestore adapter (src/lib/db.ts).
// =============================================================

import { db } from './db';
import type { ConflictType, ReassignmentCandidate, ConflictResolutionResult } from '@/types';

// ── Configuration ──────────────────────────────────────────
const CONFIG = {
  PREFERENCE_WEIGHT: 0.40,
  TIME_QUALITY_WEIGHT: 0.25,
  SUBJECT_PREF_WEIGHT: 0.20,
  LOAD_BALANCE_WEIGHT: 0.15,

  AUTO_RESOLVE_THRESHOLD: 0.75,
  ESCALATE_THRESHOLD: 0.50,
  MAX_CASCADE_DEPTH: 3,
  RESOLUTION_TIMEOUT_MS: 30000,

  PREFER_ORIGINAL_TIME: true,
  PREFER_PREFERRED_DAYS: true,
  NOTIFY_ALL_AFFECTED: true,

  SLOT_START: 7,   // 07:00
  SLOT_END: 21,    // 21:00
  SLOT_STEP: 1,    // 1-hour granularity for candidate generation
};

const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

// ── Helpers ────────────────────────────────────────────────

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

function minutesToTime(mins: number): string {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timesOverlap(
  start1: string, end1: string,
  start2: string, end2: string,
): boolean {
  const s1 = timeToMinutes(start1), e1 = timeToMinutes(end1);
  const s2 = timeToMinutes(start2), e2 = timeToMinutes(end2);
  return s1 < e2 && s2 < e1;
}

function parseJson<T>(val: string | null | undefined, fallback: T): T {
  if (!val) return fallback;
  try { return JSON.parse(val); } catch { return fallback; }
}

function durationHours(start: string, end: string): number {
  return (timeToMinutes(end) - timeToMinutes(start)) / 60;
}

// ── Phase 1: Conflict Detection ────────────────────────────

export interface DetectedConflict {
  type: ConflictType;
  scheduleId1: string;
  scheduleId2: string | null;
  description: string;
  severity: 'critical' | 'warning' | 'info';
  facultyIds: string[];
  subjectId?: string;
}

export async function detectConflicts(): Promise<DetectedConflict[]> {
  const conflicts: DetectedConflict[] = [];
  const schedules = await db.schedule.findMany({
    include: { subject: true, faculty: true, section: true, room: true },
  });

  // ── 1. Pairwise checks: faculty double-booking, room double-booking, section overlap ──
  for (let i = 0; i < schedules.length; i++) {
    for (let j = i + 1; j < schedules.length; j++) {
      const a = schedules[i], b = schedules[j];
      if (a.day !== b.day) continue;
      if (!timesOverlap(a.startTime, a.endTime, b.startTime, b.endTime)) continue;

      // Faculty double-booking
      if (a.facultyId === b.facultyId) {
        const facultyName = a.faculty?.name || b.faculty?.name || 'Unknown';
        conflicts.push({
          type: 'faculty_double_booking',
          scheduleId1: a.id,
          scheduleId2: b.id,
          description: `${facultyName} is double-booked on ${a.day} ${a.startTime}–${a.endTime} and ${b.startTime}–${b.endTime}`,
          severity: 'critical',
          facultyIds: [a.facultyId],
          subjectId: a.subjectId,
        });
      }

      // Room double-booking
      if (a.roomId === b.roomId) {
        const roomName = a.room?.roomName || b.room?.roomName || 'Unknown';
        conflicts.push({
          type: 'room_double_booking',
          scheduleId1: a.id,
          scheduleId2: b.id,
          description: `Room ${roomName} is double-booked on ${a.day} ${a.startTime}–${a.endTime} and ${b.startTime}–${b.endTime}`,
          severity: 'critical',
          facultyIds: [a.facultyId, b.facultyId],
        });
      }

      // Section overlap
      if (a.sectionId === b.sectionId) {
        const sectionName = a.section?.sectionName || b.section?.sectionName || 'Unknown';
        conflicts.push({
          type: 'section_overlap',
          scheduleId1: a.id,
          scheduleId2: b.id,
          description: `Section ${sectionName} has overlapping classes on ${a.day} ${a.startTime}–${a.endTime} and ${b.startTime}–${b.endTime}`,
          severity: 'critical',
          facultyIds: [a.facultyId, b.facultyId],
        });
      }
    }
  }

  // ── 2. Single-schedule checks: capacity exceeded, equipment mismatch ──
  for (const s of schedules) {
    const roomCap = s.room?.capacity ?? 0;
    const sectionCount = s.section?.studentCount ?? 0;
    if (roomCap > 0 && sectionCount > roomCap) {
      conflicts.push({
        type: 'capacity_exceeded',
        scheduleId1: s.id,
        scheduleId2: null,
        description: `Room ${s.room?.roomName || '?'} (cap ${roomCap}) too small for section ${s.section?.sectionName || '?'} (${sectionCount} students)`,
        severity: 'warning',
        facultyIds: [s.facultyId],
        subjectId: s.subjectId,
      });
    }

    // Equipment mismatch
    const requiredSpec = parseJson<string[]>(s.subject?.requiredSpecialization, []);
    const roomEquip = parseJson<string[]>(s.room?.equipment, []);
    // We only flag if the subject has required equipment expectations
    // For now, we check if room has basic equipment needed
    // This is a soft check — only warn if the room has NO equipment and subject requires lab
    const subjectName = (s.subject?.subjectName || '').toLowerCase();
    const needsLab = subjectName.includes('lab') || subjectName.includes('computer') || subjectName.includes('programming');
    if (needsLab && roomEquip.length === 0) {
      conflicts.push({
        type: 'equipment_mismatch',
        scheduleId1: s.id,
        scheduleId2: null,
        description: `${s.subject?.subjectName || 'Subject'} likely requires lab equipment, but room ${s.room?.roomName || '?'} has none listed`,
        severity: 'info',
        facultyIds: [s.facultyId],
        subjectId: s.subjectId,
      });
    }
  }

  return conflicts;
}

// ── Phase 2: Intelligent Reassignment ─────────────────────

interface ScheduleWithRelations {
  id: string;
  subjectId: string;
  facultyId: string;
  sectionId: string;
  roomId: string;
  day: string;
  startTime: string;
  endTime: string;
  status: string;
  subject?: { id: string; subjectCode: string; subjectName: string; units: number; departmentId: string; requiredSpecialization: string };
  faculty?: { id: string; name: string; departmentId: string | null; maxUnits: number; specialization: string };
  section?: { id: string; sectionName: string; studentCount: number; departmentId: string };
  room?: { id: string; roomName: string; capacity: number; equipment: string; building: string };
}

/**
 * Generate alternative slot candidates for a conflicting schedule.
 * Returns candidates sorted by score (highest first).
 */
export async function generateAlternatives(
  scheduleId: string,
  conflictType: ConflictType,
): Promise<ReassignmentCandidate[]> {
  const schedule = await db.schedule.findUnique({
    where: { id: scheduleId },
    include: { subject: true, faculty: true, section: true, room: true },
  });
  if (!schedule) return [];

  // Get faculty preferences
  const pref = await db.facultyPreference.findUnique({
    where: { facultyId: schedule.facultyId },
  });

  const preferredDays: string[] = pref ? parseJson(pref.preferredDays, []) : [];
  const preferredTimeStart: string = pref?.preferredTimeStart || '08:00';
  const preferredTimeEnd: string = pref?.preferredTimeEnd || '17:00';
  const unavailableDays: string[] = pref ? parseJson(pref.unavailableDays, []) : [];
  const preferredSubjects: string[] = pref ? parseJson(pref.preferredSubjects, []) : [];

  // Get all schedules for conflict checking
  const allSchedules = await db.schedule.findMany({
    include: { subject: true, faculty: true, section: true, room: true },
  });

  // Get available rooms
  const rooms = await db.room.findMany({ where: { isActive: true } });

  // Duration of the original class
  const dur = durationHours(schedule.startTime, schedule.endTime);
  const durMinutes = timeToMinutes(schedule.endTime) - timeToMinutes(schedule.startTime);

  // Count faculty load per day (for load balance scoring)
  const facultyDayLoad: Record<string, number> = {};
  for (const s of allSchedules) {
    if (s.facultyId === schedule.facultyId && s.id !== scheduleId) {
      facultyDayLoad[s.day] = (facultyDayLoad[s.day] || 0) + durationHours(s.startTime, s.endTime);
    }
  }

  const candidates: ReassignmentCandidate[] = [];

  // Generate candidates for each day
  for (const day of ALL_DAYS) {
    // Hard constraint: skip unavailable days
    if (unavailableDays.includes(day)) continue;

    // Determine tier
    let tier: 1 | 2 | 3;
    let tierLabel: string;
    if (preferredDays.includes(day)) {
      tier = 1;
      tierLabel = 'Preferred Day';
    } else {
      tier = 2;
      tierLabel = 'Available Day';
    }

    // Generate time slots
    for (let hour = CONFIG.SLOT_START; hour + dur <= CONFIG.SLOT_END; hour++) {
      const newStart = minutesToTime(hour * 60);
      const newEnd = minutesToTime(hour * 60 + durMinutes);

      // Skip if same as original (no point suggesting the same slot)
      if (day === schedule.day && newStart === schedule.startTime && newEnd === schedule.endTime) continue;

      // For each available room
      for (const room of rooms) {
        // Skip if room is too small
        const sectionCount = schedule.section?.studentCount ?? 0;
        if (room.capacity < sectionCount) continue;

        // Check for conflicts at this day/time/room
        const hasFacultyConflict = allSchedules.some(s =>
          s.id !== scheduleId &&
          s.facultyId === schedule.facultyId &&
          s.day === day &&
          timesOverlap(s.startTime, s.endTime, newStart, newEnd)
        );
        if (hasFacultyConflict) continue;

        const hasRoomConflict = allSchedules.some(s =>
          s.id !== scheduleId &&
          s.roomId === room.id &&
          s.day === day &&
          timesOverlap(s.startTime, s.endTime, newStart, newEnd)
        );
        if (hasRoomConflict) continue;

        const hasSectionConflict = allSchedules.some(s =>
          s.id !== scheduleId &&
          s.sectionId === schedule.sectionId &&
          s.day === day &&
          timesOverlap(s.startTime, s.endTime, newStart, newEnd)
        );
        if (hasSectionConflict) continue;

        // ── Score the candidate ──
        // Tier1Bonus
        const tier1Bonus = tier === 1 ? 1.0 : 0.5;

        // TimeQuality: 1.0 for preferred hours, 0.8 for extended, 0.6 for others
        const prefStart = timeToMinutes(preferredTimeStart);
        const prefEnd = timeToMinutes(preferredTimeEnd);
        const slotStart = timeToMinutes(newStart);
        const slotEnd = timeToMinutes(newEnd);
        const withinPreferred = slotStart >= prefStart && slotEnd <= prefEnd;
        const withinExtended = slotStart >= (prefStart - 60) && slotEnd <= (prefEnd + 60);
        const timeQuality = withinPreferred ? 1.0 : withinExtended ? 0.8 : 0.6;

        // PreferredSubjectBonus
        const subjectPref = preferredSubjects.includes(schedule.subjectId) ? 1.0 : 0.3;

        // LoadBalanceBonus: inverse of current load on this day
        const currentLoad = facultyDayLoad[day] || 0;
        const maxLoad = schedule.faculty?.maxUnits || 24;
        const loadBalance = Math.max(0, 1 - currentLoad / maxLoad);

        // Final score
        const score = (
          tier1Bonus * CONFIG.PREFERENCE_WEIGHT +
          timeQuality * CONFIG.TIME_QUALITY_WEIGHT +
          subjectPref * CONFIG.SUBJECT_PREF_WEIGHT +
          loadBalance * CONFIG.LOAD_BALANCE_WEIGHT
        );

        // Determine if last resort
        const isLastResort = !withinExtended && tier === 2;
        const finalTier = isLastResort ? 3 : tier;
        const finalTierLabel = isLastResort ? 'Last Resort' : tierLabel;

        candidates.push({
          scheduleId,
          newDay: day,
          newStartTime: newStart,
          newEndTime: newEnd,
          newRoomId: room.id,
          originalDay: schedule.day,
          originalStartTime: schedule.startTime,
          originalEndTime: schedule.endTime,
          originalRoomId: schedule.roomId,
          score,
          tier: finalTier,
          tierLabel: finalTierLabel,
          conflictReason: conflictType.replace(/_/g, ' '),
          rescheduleReason: finalTier === 1
            ? 'automatically_reassigned_to_preferred_day'
            : finalTier === 2
            ? 'automatically_reassigned_to_available_day'
            : 'automatically_reassigned_last_resort',
        });
      }
    }
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // Return top candidates (limit to prevent huge responses)
  return candidates.slice(0, 50);
}

/**
 * Apply a reassignment: move a schedule to a new day/time/room.
 */
async function applyReassignment(
  candidate: ReassignmentCandidate,
  resolvedBy: string,
): Promise<{ success: boolean; message: string }> {
  try {
    // Get original schedule data for logging
    const original = await db.schedule.findUnique({
      where: { id: candidate.scheduleId },
    });
    if (!original) {
      return { success: false, message: 'Schedule not found' };
    }

    // Update the schedule
    await db.schedule.update({
      where: { id: candidate.scheduleId },
      data: {
        day: candidate.newDay,
        startTime: candidate.newStartTime,
        endTime: candidate.newEndTime,
        roomId: candidate.newRoomId,
        status: 'rescheduled_due_conflict',
      },
    });

    // Log the change
    await db.scheduleLog.create({
      data: {
        scheduleId: candidate.scheduleId,
        modifiedBy: resolvedBy,
        oldValue: JSON.stringify({
          day: original.day,
          startTime: original.startTime,
          endTime: original.endTime,
          roomId: original.roomId,
          status: original.status,
        }),
        newValue: JSON.stringify({
          day: candidate.newDay,
          startTime: candidate.newStartTime,
          endTime: candidate.newEndTime,
          roomId: candidate.newRoomId,
          status: 'rescheduled_due_conflict',
        }),
        action: 'modified',
        reason: `Conflict auto-resolution: ${candidate.conflictReason}. ${candidate.rescheduleReason}`,
      },
    });

    return { success: true, message: `Reassigned to ${candidate.newDay} ${candidate.newStartTime}–${candidate.newEndTime}` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, message: `Reassignment failed: ${msg}` };
  }
}

/**
 * Validate that a reassignment won't create new conflicts.
 */
async function validateReassignment(candidate: ReassignmentCandidate): Promise<{
  valid: boolean;
  newConflicts: string[];
}> {
  const newConflicts: string[] = [];

  // Get all other schedules
  const allSchedules = await db.schedule.findMany({
    include: { subject: true, faculty: true, section: true, room: true },
  });

  // Filter out the schedule being moved
  const others = allSchedules.filter(s => s.id !== candidate.scheduleId);

  // Check for conflicts at the new slot
  for (const s of others) {
    if (s.day !== candidate.newDay) continue;
    if (!timesOverlap(s.startTime, s.endTime, candidate.newStartTime, candidate.newEndTime)) continue;

    // Get the schedule being moved to find its faculty/section
    const moved = await db.schedule.findUnique({
      where: { id: candidate.scheduleId },
    });
    if (!moved) continue;

    // Faculty conflict
    if (s.facultyId === moved.facultyId) {
      newConflicts.push(`Faculty conflict with ${s.subject?.subjectCode || '?'} on ${candidate.newDay} ${candidate.newStartTime}`);
    }

    // Room conflict
    if (s.roomId === candidate.newRoomId) {
      newConflicts.push(`Room conflict with ${s.subject?.subjectCode || '?'} on ${candidate.newDay} ${candidate.newStartTime}`);
    }

    // Section conflict
    if (s.sectionId === moved.sectionId) {
      newConflicts.push(`Section conflict with ${s.subject?.subjectCode || '?'} on ${candidate.newDay} ${candidate.newStartTime}`);
    }
  }

  return { valid: newConflicts.length === 0, newConflicts };
}

/**
 * Auto-resolve a single conflict.
 */
export async function resolveConflict(
  conflictId: string,
  resolvedBy: string,
  cascadeDepth: number = 0,
): Promise<ConflictResolutionResult> {
  if (cascadeDepth > CONFIG.MAX_CASCADE_DEPTH) {
    return {
      conflictId,
      success: false,
      strategy: 'escalated',
      message: 'Max cascade depth reached — requires manual review',
    };
  }

  // Get the conflict
  const conflict = await db.conflict.findUnique({ where: { id: conflictId } });
  if (!conflict) {
    return { conflictId, success: false, strategy: 'manual_review', message: 'Conflict not found' };
  }
  if (conflict.resolved) {
    return { conflictId, success: true, strategy: 'auto_resolved', message: 'Already resolved' };
  }

  // Only resolve critical/warning conflicts with schedule pairs
  const scheduleId = conflict.scheduleId1;
  const conflictType = conflict.type as ConflictType;

  // For capacity/equipment issues, we can try to find a different room
  // For double-booking, we need to move one of the schedules
  const targetScheduleId = scheduleId;

  // Generate alternatives
  const candidates = await generateAlternatives(targetScheduleId, conflictType);

  if (candidates.length === 0) {
    // No alternatives found — escalate
    await db.conflict.update({
      where: { id: conflictId },
      data: {
        resolutionStatus: 'escalated',
        resolutionStrategy: 'no_alternatives_available',
      },
    });

    // Mark schedule as conflict_unresolved
    await db.schedule.update({
      where: { id: targetScheduleId },
      data: { status: 'conflict_unresolved' },
    });

    return {
      conflictId,
      success: false,
      strategy: 'escalated',
      message: 'No available alternatives — escalated for manual review',
    };
  }

  // Try candidates in order of score
  for (const candidate of candidates) {
    // Validate: check for cascading conflicts
    const validation = await validateReassignment(candidate);

    if (!validation.valid) {
      // Try to cascade-resolve new conflicts
      continue; // For now, skip and try next candidate
    }

    // Check score threshold
    if (candidate.score >= CONFIG.AUTO_RESOLVE_THRESHOLD) {
      // Auto-resolve
      const result = await applyReassignment(candidate, resolvedBy);

      if (result.success) {
        // Mark conflict as resolved
        await db.conflict.update({
          where: { id: conflictId },
          data: {
            resolved: true,
            resolvedBy,
            resolvedAt: new Date().toISOString(),
            resolutionStatus: 'auto_resolved',
            resolutionStrategy: candidate.rescheduleReason,
            suggestedResolution: `Moved to ${candidate.newDay} ${candidate.newStartTime}–${candidate.newEndTime} (score: ${candidate.score.toFixed(2)}, tier: ${candidate.tierLabel})`,
          },
        });

        return {
          conflictId,
          success: true,
          strategy: 'auto_resolved',
          candidate,
          message: result.message,
        };
      }
    } else if (candidate.score >= CONFIG.ESCALATE_THRESHOLD) {
      // Good candidate but below auto-resolve threshold — mark for review
      await db.conflict.update({
        where: { id: conflictId },
        data: {
          resolutionStatus: 'manual_review',
          resolutionStrategy: 'below_auto_resolve_threshold',
          suggestedResolution: `Best candidate: ${candidate.newDay} ${candidate.newStartTime}–${candidate.newEndTime} (score: ${candidate.score.toFixed(2)})`,
        },
      });

      return {
        conflictId,
        success: false,
        strategy: 'manual_review',
        candidate,
        message: `Best candidate score ${candidate.score.toFixed(2)} below auto-resolve threshold ${CONFIG.AUTO_RESOLVE_THRESHOLD}`,
      };
    }
  }

  // All candidates exhausted
  await db.conflict.update({
    where: { id: conflictId },
    data: {
      resolutionStatus: 'escalated',
      resolutionStrategy: 'all_candidates_exhausted',
    },
  });

  await db.schedule.update({
    where: { id: targetScheduleId },
    data: { status: 'conflict_unresolved' },
  });

  return {
    conflictId,
    success: false,
    strategy: 'escalated',
    message: 'All candidates exhausted — escalated for manual review',
  };
}

/**
 * Batch resolve all unresolved conflicts.
 */
export async function resolveAllConflicts(
  resolvedBy: string,
): Promise<ConflictResolutionResult[]> {
  const unresolved = await db.conflict.findMany({
    where: { resolved: false },
  });

  // Sort by severity (critical first)
  const severityOrder: Record<string, number> = { critical: 0, warning: 1, info: 2 };
  unresolved.sort((a, b) => (severityOrder[a.severity || 'warning'] ?? 1) - (severityOrder[b.severity || 'warning'] ?? 1));

  const results: ConflictResolutionResult[] = [];

  for (const conflict of unresolved) {
    const result = await resolveConflict(conflict.id, resolvedBy, 0);
    results.push(result);
  }

  return results;
}

/**
 * Manual reassignment: move a schedule to a specific day/time/room.
 */
export async function manualResolve(
  scheduleId: string,
  newDay: string,
  newStartTime: string,
  newEndTime: string,
  newRoomId: string,
  resolvedBy: string,
  reason?: string,
): Promise<ConflictResolutionResult> {
  // Get the original schedule
  const original = await db.schedule.findUnique({
    where: { id: scheduleId },
  });
  if (!original) {
    return {
      conflictId: '',
      success: false,
      strategy: 'manual_review',
      message: 'Schedule not found',
    };
  }

  // Create candidate
  const candidate: ReassignmentCandidate = {
    scheduleId,
    newDay,
    newStartTime,
    newEndTime,
    newRoomId,
    originalDay: original.day,
    originalStartTime: original.startTime,
    originalEndTime: original.endTime,
    originalRoomId: original.roomId,
    score: 0,
    tier: 1,
    tierLabel: 'Manual Assignment',
    conflictReason: 'manual_reassignment',
    rescheduleReason: reason || 'manually_reassigned',
  };

  // Validate
  const validation = await validateReassignment(candidate);
  if (!validation.valid) {
    return {
      conflictId: '',
      success: false,
      strategy: 'manual_review',
      candidate,
      message: `New conflicts would be created: ${validation.newConflicts.join('; ')}`,
    };
  }

  // Apply
  const result = await applyReassignment(candidate, resolvedBy);

  if (result.success) {
    // Also mark any conflicts involving this schedule as resolved
    const relatedConflicts = await db.conflict.findMany({
      where: {
        resolved: false,
      },
    });

    for (const c of relatedConflicts) {
      if (c.scheduleId1 === scheduleId || c.scheduleId2 === scheduleId) {
        await db.conflict.update({
          where: { id: c.id },
          data: {
            resolved: true,
            resolvedBy,
            resolvedAt: new Date().toISOString(),
            resolutionStatus: 'auto_resolved',
            resolutionStrategy: 'manual_reassignment_resolved',
            suggestedResolution: `Schedule manually moved to ${newDay} ${newStartTime}–${newEndTime}`,
          },
        });
      }
    }
  }

  return {
    conflictId: '',
    success: result.success,
    strategy: 'manual_review',
    candidate,
    message: result.message,
  };
}

// ── Phase 3: Notification Helpers ─────────────────────────

/**
 * Build notification payloads for a conflict resolution.
 * These are returned so the API route can send them.
 */
export function buildResolutionNotifications(
  candidate: ReassignmentCandidate,
  schedule: ScheduleWithRelations,
  strategy: string,
): {
  facultyNotification: { title: string; message: string; type: string };
  adminNotification: { title: string; message: string; type: string };
} {
  const subjectCode = schedule.subject?.subjectCode || 'N/A';
  const subjectName = schedule.subject?.subjectName || 'N/A';
  const facultyName = schedule.faculty?.name || 'N/A';
  const sectionName = schedule.section?.sectionName || 'N/A';

  return {
    facultyNotification: {
      title: '📅 Schedule Changed Due to Conflict',
      type: 'warning',
      message:
        `Your ${subjectCode} - ${subjectName} (Section: ${sectionName}) has been rescheduled.\n\n` +
        `❌ ORIGINAL: ${candidate.originalDay} ${candidate.originalStartTime}–${candidate.originalEndTime}\n` +
        `✅ NEW: ${candidate.newDay} ${candidate.newStartTime}–${candidate.newEndTime}\n\n` +
        `Reason: ${candidate.conflictReason}\n` +
        `This change was made to avoid a scheduling conflict. ` +
        `Please review your updated schedule on the dashboard.`,
    },
    adminNotification: {
      title: '📊 Conflict Auto-Resolved',
      type: 'info',
      message:
        `Conflict resolved (${strategy}):\n` +
        `- Faculty: ${facultyName}\n` +
        `- Subject: ${subjectCode} - ${subjectName}\n` +
        `- Original: ${candidate.originalDay} ${candidate.originalStartTime}–${candidate.originalEndTime}\n` +
        `- New: ${candidate.newDay} ${candidate.newStartTime}–${candidate.newEndTime}\n` +
        `- Score: ${candidate.score.toFixed(2)} (${candidate.tierLabel})\n` +
        `- Reason: ${candidate.rescheduleReason}`,
    },
  };
}

import { NextResponse } from 'next/server';
import { requireAuth, requireAdmin, isAdmin, isDeptHead, validateDocumentOwnership } from '@/lib/dept-auth';
import { db } from '@/lib/db';
import { detectConflicts, type DetectedConflict } from '@/lib/conflict-resolver';

// POST /api/conflicts/detect
// Runs conflict detection and creates new conflict records (deduplicating by type+scheduleId1+scheduleId2)
export async function POST() {
  try {
    // Auth: any logged-in user can trigger detection
    const authResult = await requireAuth();
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error.error },
        { status: authResult.error.status }
      );
    }

    const { session } = authResult;

    // Run detection
    const detectedConflicts: DetectedConflict[] = await detectConflicts();

    let newCount = 0;
    let existingCount = 0;

    for (const conflict of detectedConflicts) {
      // Check if this conflict already exists (deduplicate by type+scheduleId1+scheduleId2+unresolved)
      const existing = await db.conflict.findFirst({
        where: {
          type: conflict.type,
          scheduleId1: conflict.scheduleId1,
          scheduleId2: conflict.scheduleId2,
          resolved: false,
        },
      });

      if (existing) {
        existingCount++;
        continue;
      }

      // For dept_head: only create conflicts that belong to their department
      if (isDeptHead(session) && !isAdmin(session)) {
        const schedule = conflict.scheduleId1
          ? await db.schedule.findUnique({
              where: { id: conflict.scheduleId1 },
              include: { section: { select: { departmentId: true } } },
            })
          : null;

        const scheduleDepartmentId = schedule?.section?.departmentId ?? null;
        const ownership = validateDocumentOwnership(session, scheduleDepartmentId);
        if (!ownership.allowed) {
          continue; // Skip conflicts outside dept_head's department
        }
      }

      // Create new conflict record
      await db.conflict.create({
        data: {
          type: conflict.type,
          scheduleId1: conflict.scheduleId1,
          scheduleId2: conflict.scheduleId2,
          description: conflict.description,
          severity: conflict.severity,
          facultyIds: JSON.stringify(conflict.facultyIds),
          subjectId: conflict.subjectId || undefined,
          resolved: false,
          resolutionStatus: 'pending',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      });

      newCount++;
    }

    // Log the detection run
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'detect',
        entity: 'conflict',
        details: JSON.stringify({
          detected: detectedConflicts.length,
          newCount,
          existingCount,
          triggeredBy: session.user.role,
        }),
        createdAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({
      conflicts: detectedConflicts,
      newCount,
      existingCount,
    });
  } catch (error) {
    console.error('Error running conflict detection:', error);
    return NextResponse.json(
      { error: 'Failed to run conflict detection' },
      { status: 500 }
    );
  }
}

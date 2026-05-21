import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAdmin, isDeptHead, validateDocumentOwnership } from '@/lib/dept-auth';
import { db } from '@/lib/db';
import { manualResolve, buildResolutionNotifications } from '@/lib/conflict-resolver';
import type { ConflictResolutionFormData } from '@/types';

// PUT /api/conflicts/[id]/manual-resolve
// Manually reassign a schedule to resolve a conflict
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Auth: requireAdmin or requireAuth (dept_head for their department)
    const authResult = await requireAuth();
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error.error },
        { status: authResult.error.status }
      );
    }

    const { session } = authResult;
    const { id: conflictId } = await params;

    // Parse request body
    const body: ConflictResolutionFormData = await request.json();
    const { scheduleId, newDay, newStartTime, newEndTime, newRoomId, reason } = body;

    // Validate required fields
    if (!scheduleId || !newDay || !newStartTime || !newEndTime || !newRoomId) {
      return NextResponse.json(
        { error: 'Missing required fields: scheduleId, newDay, newStartTime, newEndTime, newRoomId' },
        { status: 400 }
      );
    }

    // Verify the conflict exists
    const conflict = await db.conflict.findUnique({
      where: { id: conflictId },
    });

    if (!conflict) {
      return NextResponse.json(
        { error: 'Conflict not found' },
        { status: 404 }
      );
    }

    // Validate: check that the schedule belongs to this conflict
    if (conflict.scheduleId1 !== scheduleId && conflict.scheduleId2 !== scheduleId) {
      return NextResponse.json(
        { error: 'The specified schedule does not belong to this conflict' },
        { status: 400 }
      );
    }

    // For dept_head: verify the conflict belongs to their department
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
        return NextResponse.json(
          { error: ownership.error },
          { status: ownership.status }
        );
      }
    }

    // Run manual resolution
    const result = await manualResolve(
      scheduleId,
      newDay,
      newStartTime,
      newEndTime,
      newRoomId,
      session.user.id,
      reason
    );

    // If successful, send notifications to affected faculty
    if (result.success && result.candidate) {
      const schedule = await db.schedule.findUnique({
        where: { id: scheduleId },
        include: { subject: true, faculty: true, section: true, room: true },
      });

      if (schedule) {
        const notifications = buildResolutionNotifications(
          result.candidate,
          schedule as Parameters<typeof buildResolutionNotifications>[1],
          'manual_reassignment'
        );

        // Notify the affected faculty
        if (schedule.facultyId) {
          await db.notification.create({
            data: {
              userId: schedule.facultyId,
              title: notifications.facultyNotification.title,
              message: notifications.facultyNotification.message,
              type: notifications.facultyNotification.type,
              read: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          });
        }

        // Notify admins
        const admins = await db.user.findMany({
          where: { role: 'admin' },
        });

        for (const admin of admins) {
          await db.notification.create({
            data: {
              userId: admin.id,
              title: notifications.adminNotification.title,
              message: notifications.adminNotification.message,
              type: notifications.adminNotification.type,
              read: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          });
        }
      }

      // Mark the conflict as resolved
      await db.conflict.update({
        where: { id: conflictId },
        data: {
          resolved: true,
          resolvedBy: session.user.id,
          resolvedAt: new Date().toISOString(),
          resolutionStatus: 'auto_resolved',
          resolutionStrategy: 'manual_reassignment',
          suggestedResolution: `Schedule manually moved to ${newDay} ${newStartTime}–${newEndTime}`,
          updatedAt: new Date().toISOString(),
        },
      });
    }

    // Log the manual resolution attempt
    await db.auditLog.create({
      data: {
        userId: session.user.id,
        action: 'manual_resolve',
        entity: 'conflict',
        entityId: conflictId,
        details: JSON.stringify({
          scheduleId,
          newDay,
          newStartTime,
          newEndTime,
          newRoomId,
          reason,
          success: result.success,
          message: result.message,
        }),
        createdAt: new Date().toISOString(),
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error in manual resolve:', error);
    return NextResponse.json(
      { error: 'Failed to manually resolve conflict' },
      { status: 500 }
    );
  }
}

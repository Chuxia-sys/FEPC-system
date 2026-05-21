import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAdmin, isDeptHead, validateDocumentOwnership } from '@/lib/dept-auth';
import { db } from '@/lib/db';
import { resolveConflict, buildResolutionNotifications } from '@/lib/conflict-resolver';

// POST /api/conflicts/[id]/resolve
// Auto-resolves a single conflict
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Auth: requireAdmin or requireAuth (dept_head for their department, admin for all)
    const authResult = await requireAuth();
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error.error },
        { status: authResult.error.status }
      );
    }

    const { session } = authResult;
    const { id: conflictId } = await params;
    const resolvedBy = session.user.id;

    // Fetch the conflict to verify access
    const conflict = await db.conflict.findUnique({
      where: { id: conflictId },
    });

    if (!conflict) {
      return NextResponse.json(
        { error: 'Conflict not found' },
        { status: 404 }
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

    // Run auto-resolution
    const result = await resolveConflict(conflictId, resolvedBy);

    // If successful and a candidate exists, build and send notifications
    if (result.success && result.candidate) {
      const schedule = await db.schedule.findUnique({
        where: { id: result.candidate.scheduleId },
        include: { subject: true, faculty: true, section: true, room: true },
      });

      if (schedule) {
        const notifications = buildResolutionNotifications(
          result.candidate,
          schedule as Parameters<typeof buildResolutionNotifications>[1],
          result.strategy
        );

        // Send in-app notification to the affected faculty
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

        // Send notification to admins
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
    }

    // Log the resolution attempt
    await db.auditLog.create({
      data: {
        userId: resolvedBy,
        action: 'resolve',
        entity: 'conflict',
        entityId: conflictId,
        details: JSON.stringify({
          success: result.success,
          strategy: result.strategy,
          message: result.message,
        }),
        createdAt: new Date().toISOString(),
      },
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('Error resolving conflict:', error);
    return NextResponse.json(
      { error: 'Failed to resolve conflict' },
      { status: 500 }
    );
  }
}

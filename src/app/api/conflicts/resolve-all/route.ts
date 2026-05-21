import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/dept-auth';
import { db } from '@/lib/db';
import { resolveAllConflicts } from '@/lib/conflict-resolver';

// POST /api/conflicts/resolve-all
// Batch resolves all unresolved conflicts (admin only)
export async function POST() {
  try {
    // Auth: admin only
    const authResult = await requireAdmin();
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error.error },
        { status: authResult.error.status }
      );
    }

    const { session } = authResult;
    const resolvedBy = session.user.id;

    // Run batch resolution
    const results = await resolveAllConflicts(resolvedBy);

    // Compute summary stats
    const total = results.length;
    const resolved = results.filter(r => r.success).length;
    const escalated = results.filter(r => r.strategy === 'escalated').length;

    // Log the batch resolution
    await db.auditLog.create({
      data: {
        userId: resolvedBy,
        action: 'resolve_all',
        entity: 'conflict',
        details: JSON.stringify({
          total,
          resolved,
          escalated,
          manualReview: total - resolved - escalated,
        }),
        createdAt: new Date().toISOString(),
      },
    });

    return NextResponse.json({
      results,
      total,
      resolved,
      escalated,
    });
  } catch (error) {
    console.error('Error resolving all conflicts:', error);
    return NextResponse.json(
      { error: 'Failed to resolve all conflicts' },
      { status: 500 }
    );
  }
}

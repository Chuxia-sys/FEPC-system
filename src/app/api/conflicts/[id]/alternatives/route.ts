import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/dept-auth';
import { db } from '@/lib/db';
import { generateAlternatives } from '@/lib/conflict-resolver';
import type { ConflictType } from '@/types';

// GET /api/conflicts/[id]/alternatives
// Returns reassignment candidates for a conflict
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Auth: any logged-in user
    const authResult = await requireAuth();
    if ('error' in authResult) {
      return NextResponse.json(
        { error: authResult.error.error },
        { status: authResult.error.status }
      );
    }

    const { id: conflictId } = await params;

    // Get the conflict
    const conflict = await db.conflict.findUnique({
      where: { id: conflictId },
    });

    if (!conflict) {
      return NextResponse.json(
        { error: 'Conflict not found' },
        { status: 404 }
      );
    }

    const scheduleId1 = conflict.scheduleId1;
    const conflictType = conflict.type as ConflictType;

    if (!scheduleId1) {
      return NextResponse.json(
        { error: 'Conflict has no associated schedule' },
        { status: 400 }
      );
    }

    // Generate alternatives
    const candidates = await generateAlternatives(scheduleId1, conflictType);

    return NextResponse.json({
      alternatives: candidates,
    });
  } catch (error) {
    console.error('Error generating alternatives:', error);
    return NextResponse.json(
      { error: 'Failed to generate alternatives' },
      { status: 500 }
    );
  }
}

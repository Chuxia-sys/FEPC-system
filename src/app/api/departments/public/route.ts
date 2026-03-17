import { NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/departments/public - Public endpoint for fetching departments (for registration)
export async function GET() {
  try {
    const departments = await db.department.findMany({
      select: {
        id: true,
        name: true,
        code: true,
      },
      orderBy: { name: 'asc' },
    });

    return NextResponse.json(departments);
  } catch (error) {
    console.error('Error fetching departments:', error);
    return NextResponse.json({ error: 'Failed to fetch departments' }, { status: 500 });
  }
}

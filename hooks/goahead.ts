// When to tell Claude the brief was approved. register.ts polls the branch's approval and keeps the last one
// it saw in $.state; this decides from that record and what it reads now. Pure: no engine calls here.

export type Seen = { branch: string; approvedAt: number | null }

// `prev` is what the last poll saw (null before the first poll of the session). An approval only counts when
// it is newer than one already seen on the same branch, so a brief approved before the session started (or
// before a reload, or on a branch just switched to) says nothing.
export function goAhead(prev: Seen | null, now: Seen, firstChunk?: string): string | null {
  if (!prev || prev.branch !== now.branch || now.approvedAt === null) return null
  if (prev.approvedAt !== null && now.approvedAt <= prev.approvedAt) return null
  if (prev.approvedAt === null)
    return `The brief for ${now.branch} is approved. Start on chunk 1${firstChunk ? ` (${firstChunk})` : ''} and work through the chunks, finishing each one as the brief's procedure says.`
  return `The change to the brief for ${now.branch} is approved. Carry on with the plan as it stands now.`
}

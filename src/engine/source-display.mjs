// Only the current provider is shown while working; completion keeps the winner.
export function displayedService(rec) {
  if (rec.status === 'completed') return rec.result?.step?.service || rec.step?.service || null;
  if (rec.status === 'searching' || rec.status === 'downloading') return rec.step?.service || null;
  return null;
}

// Only the current provider is shown while working; completion keeps the winner.
export function displayedService(rec) {
  if (!rec) return null;
  if (rec.status === 'completed') {
    return rec.transferService || rec.result?.step?.service || rec.step?.service || rec.item?.service || null;
  }
  if (rec.status === 'ready' || rec.status === 'downloading') {
    return rec.transferService || rec.step?.service || rec.item?.service || null;
  }
  if (rec.status === 'searching') {
    return rec.step?.service || null;
  }
  return null;
}

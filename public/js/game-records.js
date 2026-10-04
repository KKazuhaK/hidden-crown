export function thinkingSeconds(milliseconds, role) {
  const seconds = Number.isFinite(milliseconds) ? Math.max(0, milliseconds) / 1000 : 0;
  return role === 'observer' ? seconds.toFixed(3) : String(Math.floor(seconds));
}
export function recordsCsv(records) {
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return ['ply,color,notation,piece_id,captured_id,think_ms,timestamp_iso,action,target_id,target_square,interrogation_answer', ...records.map(record =>
    [record.ply, record.color, record.notation, record.pieceId, record.captured, record.thinkMs, new Date(record.at).toISOString(), record.kind ?? 'move', record.targetId, record.targetSquare, record.answer].map(quote).join(','))].join('\r\n');
}
export function actionLabel(record, translate, pieces) {
  if (record.kind !== 'interrogation') return record.notation;
  const piece = pieces[record.targetId];
  const square = 'abcdefgh'[record.targetSquare % 8] + (Math.floor(record.targetSquare / 8) + 1);
  const actor = pieces[record.pieceId]?.type ?? record.pieceId?.[1] ?? 'K';
  return translate('interrogationRecord', { actor: translate(actor), piece: translate(piece?.type ?? 'Q'), square }) + ' · ' + translate(record.answer ? `interrogation_${record.answer}` : 'interrogation_private');
}

export function recordsCsv(records) {
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return ['ply,color,notation,piece_id,captured_id,think_ms,timestamp_iso,action,target_id,target_square,interrogation_answer', ...records.map(record =>
    [record.ply, record.color, record.notation, record.pieceId, record.captured, record.thinkMs, new Date(record.at).toISOString(), record.kind ?? 'move', record.targetId, record.targetSquare, record.answer].map(quote).join(','))].join('\r\n');
}
export function actionLabel(record, translate, pieces) {
  if (record.kind !== 'interrogation') return record.notation;
  const piece = pieces[record.targetId];
  const square = 'abcdefgh'[record.targetSquare % 8] + (Math.floor(record.targetSquare / 8) + 1);
  return translate('interrogationRecord', { piece: translate(piece?.type ?? 'K'), square }) + ' · ' + translate(record.answer ? `interrogation_${record.answer}` : 'interrogation_private');
}

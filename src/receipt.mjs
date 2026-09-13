const validationKeys = [
  'reopened',
  'rawStreamsPreserved',
  'originalRawStreamsPreserved',
  'pageBoxesVerified',
  'patchedContentsVerified',
  'unchangedObjectsVerified',
  'whitespaceSourceChecks',
  'panelForms',
  'rasterized',
];

export function summarizeReceipt(receipt, options = {}) {
  const validation = {};
  for (const key of validationKeys) {
    if (receipt.validation?.[key] !== undefined) validation[key] = receipt.validation[key];
  }
  if (Array.isArray(receipt.validation?.pixelGates)) {
    validation.pixelGates = {
      count: receipt.validation.pixelGates.length,
      changedPixelsInside: receipt.validation.pixelGates.reduce((sum, gate) => sum + (Number(gate.changedPixelsInside) || 0), 0),
      changedPixelsOutside: receipt.validation.pixelGates.reduce((sum, gate) => sum + (Number(gate.changedPixelsOutside) || 0), 0),
    };
  }
  if (Array.isArray(receipt.validation?.fontExpansions)) validation.fontExpansionCount = receipt.validation.fontExpansions.length;
  if (Array.isArray(receipt.validation?.fontReuses)) validation.fontReuseCount = receipt.validation.fontReuses.length;

  const summary = {
    version: receipt.version,
    output: receipt.output,
    outputSha256: receipt.outputSha256,
  };
  for (const key of ['sourceSha256', 'requestId', 'replayed', 'totalMs']) {
    if (receipt[key] !== undefined) summary[key] = receipt[key];
  }
  if (Array.isArray(receipt.changes)) summary.modified = receipt.changes.length;
  if (Array.isArray(receipt.placements)) summary.panels = receipt.placements.length;
  summary.validation = validation;
  if (receipt.optimization) {
    summary.optimization = {};
    for (const key of ['fontProgramsShared', 'encodedFontBytesShared']) {
      if (receipt.optimization[key] !== undefined) summary.optimization[key] = receipt.optimization[key];
    }
  }
  if (options.report !== undefined) summary.report = options.report;
  return summary;
}

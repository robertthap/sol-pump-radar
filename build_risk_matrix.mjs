import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "file:///C:/Users/rober/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const outputDir = "C:/Users/rober/sol-pump-radar/outputs/risk_matrix";
const outputPath = `${outputDir}/NextGen_Risk_Matrix.xlsx`;
const wb = Workbook.create();
const sheet = wb.worksheets.add("Risk Matrix");
sheet.showGridLines = false;
sheet.tabColor = "#1F4E78";

const navy = "#1F4E78";
const blue = "#D9EAF7";
const low = "#C6E0B4";
const medium = "#FFF2CC";
const high = "#FCE4D6";
const extreme = "#F4CCCC";
const border = "#B7C9D6";
const font = { name: "Arial", size: 10, color: "#1F1F1F" };

sheet.getRange("A2:F2").merge();
sheet.getRange("A2").values = [["NextGen Risk Assessment"]];
sheet.getRange("A2").format = { font: { name: "Arial", size: 15, bold: true, color: "#1F1F1F" }, verticalAlignment: "center" };
sheet.getRange("A2:F2").format.rowHeight = 26;

sheet.getRange("A4").values = [["Table 2: NextGen 5 × 5 Risk Matrix"]];
sheet.getRange("A4").format = { font: { name: "Arial", size: 12, bold: true, color: "#1F1F1F" } };
sheet.getRange("A5:F5").values = [["Likelihood \\ Impact", "Insignificant (1)", "Minor (2)", "Moderate (3)", "Major (4)", "Severe (5)"]];
sheet.getRange("A6:F10").values = [
  ["Almost Certain (5)", 5, 10, 15, "20 – R1", "25 – R2"],
  ["Likely (4)", 4, 8, 12, 16, 20],
  ["Possible (3)", 3, 6, 9, 12, 15],
  ["Unlikely (2)", 2, 4, 6, 8, 10],
  ["Rare (1)", 1, 2, 3, 4, 5],
];
sheet.getRange("A5:F5").format = { fill: navy, font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true };
sheet.getRange("A6:A10").format = { fill: blue, font: { name: "Arial", size: 10, bold: true }, verticalAlignment: "center" };
sheet.getRange("A5:F10").format.borders = { preset: "all", style: "thin", color: border };

const matrixColors = [
  [medium, high, extreme, extreme, extreme],
  [low, medium, high, extreme, extreme],
  [low, medium, medium, high, extreme],
  [low, low, medium, medium, high],
  [low, low, low, low, medium],
];
for (let r = 0; r < matrixColors.length; r++) {
  for (let c = 0; c < matrixColors[r].length; c++) {
    const cell = sheet.getCell(5 + r, 1 + c);
    cell.format.fill = matrixColors[r][c];
    cell.format.horizontalAlignment = "center";
    cell.format.verticalAlignment = "center";
    cell.format.font = { name: "Arial", size: 10, bold: r === 0 && c >= 3 };
  }
}
sheet.getRange("A5:F10").format.rowHeight = 23;
sheet.getRange("A5").format.rowHeight = 34;

sheet.getRange("A12:F12").values = [["Risk level", "Low (1–4)", "Medium (5–9)", "High (10–14)", "Extreme (15–25)", ""]];
sheet.getRange("A12").format = { font: { name: "Arial", size: 9, bold: true }, horizontalAlignment: "left", verticalAlignment: "center" };
sheet.getRange("B12").format = { fill: low, font, horizontalAlignment: "center" };
sheet.getRange("C12").format = { fill: medium, font, horizontalAlignment: "center" };
sheet.getRange("D12").format = { fill: high, font, horizontalAlignment: "center" };
sheet.getRange("E12").format = { fill: extreme, font, horizontalAlignment: "center" };

sheet.getRange("A15:F15").merge();
sheet.getRange("A15").values = [["Table 3: Risk Evaluation and Justification"]];
sheet.getRange("A15").format = { font: { name: "Arial", size: 12, bold: true, color: "#1F1F1F" } };
sheet.getRange("A16:F16").values = [["Risk", "Likelihood", "Impact", "Score", "Rating", "Justification"]];
sheet.getRange("A17:F18").values = [
  ["R1 – Cloud account compromise", 5, 4, 20, "Extreme", "Credential attacks are highly automated and commonly used [1]. A successful compromise could expose email, files and other connected cloud services."],
  ["R2 – Phishing-delivered endpoint malware", 5, 5, 25, "Extreme", "Phishing is frequently observed in Australian incidents [2]. Malware could steal credentials, communicate externally and disrupt multiple systems."],
];
sheet.getRange("A16:F16").format = { fill: navy, font: { name: "Arial", size: 10, bold: true, color: "#FFFFFF" }, horizontalAlignment: "center", verticalAlignment: "center", wrapText: true };
sheet.getRange("A17:A18").format = { font: { name: "Arial", size: 10, bold: true }, verticalAlignment: "center", wrapText: true };
sheet.getRange("B17:E18").format = { font, horizontalAlignment: "center", verticalAlignment: "center" };
sheet.getRange("D17:E18").format.fill = extreme;
sheet.getRange("D17:E18").format.font = { name: "Arial", size: 10, bold: true };
sheet.getRange("F17:F18").format = { font, verticalAlignment: "top", wrapText: true };
sheet.getRange("A16:F18").format.borders = { preset: "all", style: "thin", color: border };
sheet.getRange("A16:F16").format.rowHeight = 31;
sheet.getRange("A17:F18").format.rowHeight = 54;

sheet.getRange("A20:F20").merge();
sheet.getRange("A20").values = [["References [1] and [2] are retained as supplied for insertion into the report reference list."]];
sheet.getRange("A20").format = { font: { name: "Arial", size: 9, italic: true, color: "#595959" } };

sheet.getRange("A:A").format.columnWidth = 38;
sheet.getRange("B:E").format.columnWidth = 16;
sheet.getRange("F:F").format.columnWidth = 50;
sheet.getRange("A2:F20").format.verticalAlignment = "center";

wb.recalculate();
const check = await wb.inspect({ kind: "table", range: "Risk Matrix!A4:F20", include: "values,formulas", tableMaxRows: 25, tableMaxCols: 8 });
console.log(check.ndjson);
const errors = await wb.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!", options: { useRegex: true, maxResults: 50 }, summary: "final formula error scan" });
console.log(errors.ndjson);
const preview = await wb.render({ sheetName: "Risk Matrix", range: "A2:F20", scale: 1.5, format: "png" });
await fs.mkdir(outputDir, { recursive: true });
await fs.writeFile(`${outputDir}/risk_matrix_preview.png`, new Uint8Array(await preview.arrayBuffer()));
const output = await SpreadsheetFile.exportXlsx(wb);
await output.save(outputPath);
console.log(outputPath);

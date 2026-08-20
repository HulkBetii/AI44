const fs = require("fs");
const raw = fs.readFileSync("C:/Users/HulkBeoti/Documents/hotmail.txt", "utf8");
const rows = ["email,password,msaToken,tenantGuid,recoveryEmail,elevenLabsApiKey,elevenLabsPassword,status"];
for (const line of raw.split("\n")) {
  const match = line.trim().match(/^\d+\.\s+(.+)$/);
  if (!match) continue;
  const parts = match[1].split("|");
  if (parts.length < 5) continue;
  const q = (s) => '"' + s.trim().replace(/"/g, '""') + '"';
  rows.push([q(parts[0]),q(parts[1]),q(parts[2]),q(parts[3]),q(parts[4]),q(""),q(""),q("pending")].join(","));
}
fs.writeFileSync("D:/VibeCoding/mail-temp/hotmail.csv", rows.join("\n"), "utf8");
console.log("Done:", rows.length - 1, "rows -> D:/VibeCoding/mail-temp/hotmail.csv");

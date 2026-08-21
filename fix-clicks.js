const fs = require('fs');
let code = fs.readFileSync('signup-hotmail.js', 'utf8');

const replacements = [
  "await clickHuman(loginPage, PASSWORD_LINK);",
  "await clickHuman(loginPage, 'button[data-testid=\"primaryButton\"]');",
  "await clickHuman(loginPage, 'button:has-text(\"OK\")');",
  "await clickHuman(loginPage, 'button:has-text(\"No\")');",
  "await clickHuman(signupPage, 'button[style*=\"view-transition-name: submit\"]');",
  "await clickHuman(verifyPage, 'button:has-text(\"Continue\")');",
  "await clickHuman(page, '[data-testid=\"sign-in-submit-button\"]');",
  "await clickHuman(page, 'button:has-text(\"Create Key\")');",
  "await clickHuman(page, 'button:has-text(\"Continue\")');"
];

for (let r of replacements) {
  code = code.replace('/* MISSING_CLICK */', r);
}

fs.writeFileSync('signup-hotmail.js', code);
console.log('Fixed');

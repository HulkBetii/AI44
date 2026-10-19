const fs = require('fs');
let code = fs.readFileSync('signup-hotmail.js', 'utf8');

const strToReplace = `        if (mode === 'resetPassword' && !/Reset your password/i.test(subject) && !/password/i.test(subject)) {
          console.log(\`[inbox] Email \${i} is not a reset password email (subject: "\${subject}"), skipping.\`);
          continue;
        }
        if (mode === 'verifyEmail' && !/Verify your email/i.test(subject)) {
          console.log(\`[inbox] Email \${i} is not a verification email (subject: "\${subject}"), skipping.\`);
          continue;
        }`;

const newStr = `        if (expectedType === 'resetPassword' && !/Reset your password/i.test(subject) && !/password/i.test(subject)) {
          console.log(\`[inbox] Email \${i} is not a reset password email (subject: "\${subject}"), skipping.\`);
          continue;
        }
        if (expectedType === 'verifyEmail' && !/Verify your email/i.test(subject)) {
          console.log(\`[inbox] Email \${i} is not a verification email (subject: "\${subject}"), skipping.\`);
          continue;
        }`;

if (code.includes(strToReplace)) {
  fs.writeFileSync('signup-hotmail.js', code.replace(strToReplace, newStr));
  console.log('Fixed variable names');
} else {
  console.log('Could not find mode string');
}

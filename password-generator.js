const crypto = require('crypto');

const CHARACTER_GROUPS = [
  'ABCDEFGHJKLMNPQRSTUVWXYZ',
  'abcdefghijkmnopqrstuvwxyz',
  '23456789',
  '@#!$',
];
const PASSWORD_LENGTH = 20;

function generateSecurePassword() {
  const alphabet = CHARACTER_GROUPS.join('');
  const characters = CHARACTER_GROUPS.map((group) => group[crypto.randomInt(group.length)]);
  while (characters.length < PASSWORD_LENGTH) {
    characters.push(alphabet[crypto.randomInt(alphabet.length)]);
  }
  for (let index = characters.length - 1; index > 0; index--) {
    const swapIndex = crypto.randomInt(index + 1);
    [characters[index], characters[swapIndex]] = [characters[swapIndex], characters[index]];
  }
  return characters.join('');
}

module.exports = { generateSecurePassword };

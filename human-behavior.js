/**
 * human-behavior.js
 * Module mô phỏng sinh trắc học hành vi người dùng thật (Human Behavior Dynamics).
 * Chống nhận diện bot thông qua Mouse Dynamics, Keystroke Dynamics và nhịp điệu (Thinking Time).
 */

let lastMousePos = { x: 200, y: 200 }; // Tọa độ chuột giả lập ban đầu

/**
 * Trả về số ngẫu nhiên theo phân phối chuẩn (Gaussian/Normal Distribution)
 */
function randomGaussian(min, max) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  num = num / 10.0 + 0.5; // Đẩy đỉnh chuông vào giữa
  if (num > 1 || num < 0) return randomGaussian(min, max); // Re-sample
  return Math.floor(num * (max - min) + min);
}

/**
 * Sinh phân bố Poisson (mô phỏng delay hành vi biến thiên)
 * Mượn tạm cơ chế Gamma/Log để sinh độ trễ tự nhiên.
 */
function poissonDelay(averageMs) {
  const L = Math.exp(-averageMs);
  let p = 1.0;
  let k = 0;
  do {
    k++;
    p *= Math.random();
  } while (p > L && k < averageMs * 2);
  // Thực tế để code nhẹ nhàng, ta dùng phân phối chuẩn (Gaussian) lệch phải cho thời gian nghĩ.
  return randomGaussian(averageMs * 0.8, averageMs * 1.5);
}

/**
 * Tạm dừng (Thinking Time)
 */
async function think(minMs = 1500, maxMs = 3500) {
  const delay = randomGaussian(minMs, maxMs);
  await new Promise(r => setTimeout(r, delay));
}

/**
 * Sinh quỹ đạo Cubic Bezier từ Start đến End
 */
function generateBezierCurve(startX, startY, endX, endY, steps = 30) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const dist = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
  
  // P1, P2 đi chệch khỏi đường thẳng một khoảng tỷ lệ với quãng đường
  const spread = Math.max(10, dist * 0.2); 
  const p1x = startX + deltaX * 0.3 + (Math.random() - 0.5) * spread;
  const p1y = startY + deltaY * 0.3 + (Math.random() - 0.5) * spread;
  const p2x = startX + deltaX * 0.7 + (Math.random() - 0.5) * spread;
  const p2y = startY + deltaY * 0.7 + (Math.random() - 0.5) * spread;

  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.pow(1 - t, 3) * startX +
              3 * Math.pow(1 - t, 2) * t * p1x +
              3 * (1 - t) * Math.pow(t, 2) * p2x +
              Math.pow(t, 3) * endX;
    const y = Math.pow(1 - t, 3) * startY +
              3 * Math.pow(1 - t, 2) * t * p1y +
              3 * (1 - t) * Math.pow(t, 2) * p2y +
              Math.pow(t, 3) * endY;
    points.push({ x, y });
  }
  return points;
}

/**
 * Di chuyển chuột và Click như người thật (Fitts's Law, Bezier, Jitter, Overshoot)
 * @param {object} page
 * @param {string|object} selectorOrLocator Chuỗi selector hoặc đối tượng Locator của Playwright
 */
async function clickHuman(page, selectorOrLocator) {
  let locator;
  if (typeof selectorOrLocator === 'string') {
    await page.waitForSelector(selectorOrLocator, { state: 'visible' });
    locator = page.locator(selectorOrLocator).first();
  } else {
    locator = selectorOrLocator;
  }
  
  const box = await locator.boundingBox();
  if (!box) throw new Error(`Could not find bounding box for target`);

  // Chọn điểm target bất kỳ bên trong khung hình (tránh viền)
  const padX = Math.max(1, box.width * 0.1);
  const padY = Math.max(1, box.height * 0.1);
  const targetX = box.x + padX + Math.random() * (box.width - padX * 2);
  const targetY = box.y + padY + Math.random() * (box.height - padY * 2);

  // Sinh quỹ đạo Bezier
  const steps = randomGaussian(20, 40);
  const points = generateBezierCurve(lastMousePos.x, lastMousePos.y, targetX, targetY, steps);
  
  // Move dọc theo quỹ đạo
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    // Jitter: Rung tay nhẹ 1-2 pixel
    const jitterX = p.x + (Math.random() - 0.5) * 2;
    const jitterY = p.y + (Math.random() - 0.5) * 2;
    
    await page.mouse.move(jitterX, jitterY);
    
    // Fitts's Law / Ease-in-out: Giữa đoạn đi nhanh, 2 đầu đi chậm
    const t = i / points.length;
    let delayMs = 5;
    if (t < 0.2 || t > 0.8) delayMs = randomGaussian(10, 20); // Đi chậm lại
    await new Promise(r => setTimeout(r, delayMs));
  }

  // Overshoot: 30% khả năng lướt trượt ra khỏi mục tiêu một chút rồi vòng lại
  if (Math.random() < 0.3) {
    const overX = targetX + (Math.random() - 0.5) * 15;
    const overY = targetY + (Math.random() - 0.5) * 15;
    await page.mouse.move(overX, overY, { steps: 5 });
    await new Promise(r => setTimeout(r, randomGaussian(50, 150))); // Nhận ra đi lố
    await page.mouse.move(targetX, targetY, { steps: 5 }); // Quay lại tâm
  }

  // Hover nghỉ ngơi trước khi bấm
  await new Promise(r => setTimeout(r, randomGaussian(150, 350)));
  
  // MouseDown
  await page.mouse.down();
  // Khựng lại lúc nhấn đè
  await new Promise(r => setTimeout(r, randomGaussian(50, 100)));
  // MouseUp
  await page.mouse.up();
  
  lastMousePos = { x: targetX, y: targetY };
}

// Bảng đồ phím lân cận trên QWERTY để mô phỏng gõ nhầm
const QWERTY_ADJACENT = {
  'a': 'qwsz', 'b': 'vghn', 'c': 'xdfv', 'd': 'sfcxe', 'e': 'wrsd',
  'f': 'dgcvr', 'g': 'fhvtb', 'h': 'gjynb', 'i': 'uojk', 'j': 'hknmu',
  'k': 'jlmio', 'l': 'kop', 'm': 'njk', 'n': 'bhjm', 'o': 'ipkl',
  'p': 'ol', 'q': 'wa', 'r': 'etdf', 's': 'awdzx', 't': 'ryfg',
  'u': 'yihj', 'v': 'cfgb', 'w': 'qeas', 'x': 'zsdc', 'y': 'tugh', 'z': 'asx'
};

/**
 * Mô phỏng gõ bàn phím thật (Keystroke Dynamics)
 */
async function typeHuman(page, selector, text) {
  // Click vào trường nhập liệu trước bằng Human Mouse
  await clickHuman(page, selector);
  
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const lowerChar = char.toLowerCase();
    
    // Typo Simulation: 4% cơ hội gõ sai (chỉ áp dụng chữ cái QWERTY)
    if (QWERTY_ADJACENT[lowerChar] && Math.random() < 0.04) {
      const adjacents = QWERTY_ADJACENT[lowerChar];
      const typoChar = adjacents[Math.floor(Math.random() * adjacents.length)];
      
      // Gõ sai
      await page.keyboard.type(char === lowerChar ? typoChar : typoChar.toUpperCase(), { 
        delay: randomGaussian(70, 150) 
      });
      
      // Nhận ra lỗi (Dwell / Pause)
      await new Promise(r => setTimeout(r, randomGaussian(200, 400)));
      
      // Xóa lỗi
      await page.keyboard.press('Backspace', { delay: randomGaussian(70, 150) });
      
      // Khựng lại nhẹ trước khi gõ lại chữ đúng
      await new Promise(r => setTimeout(r, randomGaussian(100, 200)));
    }
    
    // Flight time: Khoảng trễ tự nhiên giữa các phím
    await page.keyboard.type(char, { delay: randomGaussian(70, 220) });
    
    // Dừng lâu hơn nếu gặp khoảng trắng, @, ., hoặc số (chuyển đổi suy nghĩ)
    if (char === ' ' || char === '@' || char === '.' || !isNaN(char)) {
      if (Math.random() < 0.5) {
        await new Promise(r => setTimeout(r, randomGaussian(300, 600)));
      }
    }
  }

  // Khắc phục lỗi React re-render làm rơi ký tự
  const landed = await page.inputValue(selector);
  if (landed !== text) {
    console.warn(`[type] field truncated (${landed.length}/${text.length} chars) - repairing`);
    await page.fill(selector, text);
    const repaired = await page.inputValue(selector);
    if (repaired !== text) {
      throw new Error(`Could not set ${selector}: wanted ${text.length} chars, field holds ${repaired.length}`);
    }
  }
}

/**
 * Cuộn trang mượt mà (Smooth Scroll)
 */
async function smoothScroll(page) {
  // Cuộn ngẫu nhiên lên hoặc xuống một đoạn ngắn (-300px đến +300px)
  const direction = Math.random() > 0.5 ? 1 : -1;
  const distance = Math.floor(Math.random() * 200) + 100;
  const steps = randomGaussian(10, 20);
  
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, (distance / steps) * direction);
    await new Promise(r => setTimeout(r, randomGaussian(10, 30)));
  }
}

/**
 * Xây dựng dữ liệu tên người thật
 */
const FIRST_NAMES = ["James", "John", "Robert", "Michael", "William", "David", "Richard", "Joseph", "Thomas", "Charles", "Mary", "Patricia", "Jennifer", "Linda", "Elizabeth", "Barbara", "Susan", "Jessica", "Sarah", "Karen", "Emma", "Olivia", "Ava", "Isabella", "Sophia", "Mia", "Amelia", "Harper", "Evelyn", "Abigail"];
const LAST_NAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez", "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin"];

function generateRealisticName() {
  const fn = FIRST_NAMES[Math.floor(Math.random() * FIRST_NAMES.length)];
  const ln = LAST_NAMES[Math.floor(Math.random() * LAST_NAMES.length)];
  return { firstName: fn, lastName: ln, fullName: `${fn} ${ln}` };
}

module.exports = {
  randomGaussian,
  poissonDelay,
  think,
  clickHuman,
  typeHuman,
  smoothScroll,
  generateRealisticName
};

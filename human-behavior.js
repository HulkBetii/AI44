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
 * Tạm dừng (Thinking Time)
 */
async function think(minMs = 1500, maxMs = 3500) {
  const delay = randomGaussian(minMs, maxMs);
  await new Promise(r => setTimeout(r, delay));
}

/**
 * Tính toán khoảng trễ theo Phân bố mũ (Exponential Distribution / Poisson Arrival Process)
 * @param {number} avgMinutes Thời gian trung bình (phút)
 * @returns {number} Thời gian trễ (mili-giây)
 */
function poissonIntervalDelay(avgMinutes, maxMultiple = 3) {
  // -ln(1-u) * mean
  const u = Math.random();
  const meanMs = avgMinutes * 60 * 1000;
  const delayMs = -Math.log(1 - u) * meanMs;
  // The exponential tail is unbounded: a draw of u=0.999 is ~7x the mean, which at
  // --interval=5 would idle the batch for over half an hour. Keep the shape, cap the tail.
  return Math.min(Math.max(1000, delayMs), meanMs * maxMultiple);
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
 * Điểm sắp click có thực sự thuộc về element mục tiêu không, hay đang bị thứ khác che.
 */
async function isCovered(locator, x, y) {
  return locator.evaluate((node, pt) => {
    const top = document.elementFromPoint(pt.x, pt.y);
    if (!top) return true;
    return !(top === node || node.contains(top) || top.contains(node));
  }, { x, y }).catch(() => false);
}

/**
 * Đưa vị trí chuột về trong viewport nếu nó đang nằm ngoài.
 * CDP-attached pages thường trả về viewportSize() null, nên phải hỏi chính trang.
 */
async function reseedMouseIfOutsideViewport(page) {
  const size = page.viewportSize()
    || await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
      .catch(() => null);
  if (!size) return;

  const inside = lastMousePos.x >= 0 && lastMousePos.x < size.width
    && lastMousePos.y >= 0 && lastMousePos.y < size.height;
  if (inside) return;

  lastMousePos = {
    x: Math.random() * size.width,
    y: Math.random() * size.height,
  };
}

/**
 * Di chuyển chuột và Click như người thật (Fitts's Law, Bezier, Jitter, Overshoot)
 * @param {object} page
 * @param {string|object} selectorOrLocator Chuỗi selector hoặc đối tượng Locator của Playwright
 */
async function clickHuman(page, selectorOrLocator, { timeoutMs = 30000 } = {}) {
  let locator;
  if (typeof selectorOrLocator === 'string') {
    await page.waitForSelector(selectorOrLocator, { state: 'visible', timeout: timeoutMs });
    locator = page.locator(selectorOrLocator).first();
  } else {
    locator = selectorOrLocator;
  }

  // Raw page.mouse events bypass every actionability check locator.click() performs, so the
  // two that this pipeline depends on have to be reproduced here.

  // 1. boundingBox() does not scroll: it reports coordinates relative to the viewport and may
  //    return values outside it, in which case the mouse would be driven to empty space.
  await locator.scrollIntoViewIfNeeded({ timeout: timeoutMs }).catch(() => {});

  // 2. Several ElevenLabs buttons ship disabled until their form validates. Clicking during
  //    that window does nothing at all, and returning as though it worked sends the caller
  //    off to blame a later step for the failure.
  const deadline = Date.now() + timeoutMs;
  while (!(await locator.isEnabled().catch(() => false))) {
    if (Date.now() > deadline) {
      const label = typeof selectorOrLocator === 'string' ? selectorOrLocator : 'target';
      throw new Error(`clickHuman: ${label} never became enabled within ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const box = await locator.boundingBox();
  if (!box) throw new Error(`Could not find bounding box for target`);

  // The stored position belongs to whichever page was clicked last. With a fresh browser per
  // account that may be outside this viewport entirely, which would start the path off-screen.
  await reseedMouseIfOutsideViewport(page);

  // Chọn điểm target bất kỳ bên trong khung hình (tránh viền)
  const padX = Math.max(1, box.width * 0.1);
  const padY = Math.max(1, box.height * 0.1);
  const randomX = box.x + padX + Math.random() * (box.width - padX * 2);
  const randomY = box.y + padY + Math.random() * (box.height - padY * 2);
  const centreX = box.x + box.width / 2;
  const centreY = box.y + box.height / 2;

  // 3. locator.click() also checks the element actually receives pointer events. Outlook's
  //    cookie modal covered the message list while the rows stayed present, visible and
  //    enabled, so raw mouse events landed on the overlay and the click did nothing.
  //
  //    A partial overlap needs a different answer from a full one: ElevenLabs puts a
  //    show/hide button over the right edge of its password fields, so a random point can be
  //    covered while the field is perfectly clickable elsewhere. Try points sliding from the
  //    random one toward the centre first, and only treat it as blocked if none is free.
  //    Overlays are also often transient, so wait one out before giving up.
  const candidates = [0, 0.4, 0.7, 1].map((t) => ({
    x: randomX + (centreX - randomX) * t,
    y: randomY + (centreY - randomY) * t,
  }));

  let point = null;
  for (;;) {
    for (const c of candidates) {
      if (!await isCovered(locator, c.x, c.y)) { point = c; break; }
    }
    if (point) break;
    if (Date.now() > deadline) {
      throw new Error(
        `clickHuman: target at (${Math.round(centreX)},${Math.round(centreY)}) is covered by another element`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const targetX = point.x;
  const targetY = point.y;

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
  think,
  poissonIntervalDelay,
  clickHuman,
  typeHuman,
  smoothScroll,
  generateRealisticName
};

const canvas = document.getElementById('grid');
const ctx = canvas.getContext('2d');
const statsEl = document.getElementById('stats');
const modal = document.getElementById('deviceModal');
const toolHelpEl = document.getElementById('toolHelp');
const PIXELS_PER_METER = 40;
const cols = Math.floor(canvas.width / PIXELS_PER_METER);
const rows = Math.floor(canvas.height / PIXELS_PER_METER);
const PROJECT_VERSION = 3;
let rooms = [];
let centralSwitch = null;
let localSwitches = [];
let cables = [];
let networkGenerated = false;
let manualWalls = new Set();
let doors = new Set();
let unreachableConnections = 0;
let lastCableLength = 0;
let currentTool = 'select';
let actionState = null;
let targetRoom = null;
let targetDevice = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let initialMousePos = null;
let selectionBox = null;
let activeRoomForModal = null;
let dragStartDoors = null;
const TOOL_HELP = {
  select: 'Выбор: перемещение комнат и оборудования.',
  wall: 'Стена: нажмите по линии сетки. Внутри поля создаётся дополнительная перегородка.',
  door: 'Дверь: нажмите на существующую стену. Кабель сможет пройти через этот сегмент.',
  erase: 'Ластик: удаляет дверь или дополнительную стену. Границы комнат не удаляются.'
};
function setTool(tool) {
  if (!['select', 'wall', 'door', 'erase'].includes(tool)) return;
  currentTool = tool;
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  if (toolHelpEl) toolHelpEl.textContent = TOOL_HELP[tool];
  canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
}
function initGrid() {
  rooms = [];
  centralSwitch = null;
  localSwitches = [];
  cables = [];
  networkGenerated = false;
  manualWalls = new Set();
  doors = new Set();
  unreachableConnections = 0;
  lastCableLength = 0;
  actionState = null;
  targetRoom = null;
  targetDevice = null;
  dragStartDoors = null;
  selectionBox = null;
  if (statsEl) statsEl.innerText = 'Ожидание генерации...';
  setTool('select');
  draw();
}
function resetNetworkCables() {
  cables = [];
  localSwitches = [];
  networkGenerated = false;
  unreachableConnections = 0;
  lastCableLength = 0;
  if (statsEl) statsEl.innerText = 'Ожидание генерации...';
}
function roomContainsCell(room, x, y) {
  return x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h;
}
function roomOccupied(x, y, w, h) {
  return rooms.some(room => {
    return x < room.x + room.w && x + w > room.x && y < room.y + room.h && y + h > room.y;
  });
}
function findRoomPlacement(w, h) {
  for (let y = 1; y <= rows - h - 1; y++) {
    for (let x = 1; x <= cols - w - 1; x++) {
      if (!roomOccupied(x, y, w, h)) return { x, y };
    }
  }
  return { x: Math.max(0, cols - w), y: Math.max(0, rows - h) };
}
function addRoom() {
  const w = Math.max(2, Math.min(15, parseInt(document.getElementById('roomW').value, 10) || 4));
  const h = Math.max(2, Math.min(15, parseInt(document.getElementById('roomH').value, 10) || 3));
  const pos = findRoomPlacement(w, h);
  rooms.forEach(room => room.selected = false);
  rooms.push({
    x: pos.x,
    y: pos.y,
    w,
    h,
    devices: [],
    selected: true
  });
  resetNetworkCables();
  cleanupDoors();
  draw();
}
function addRoomFromToolbar() {
  addRoom();
}
function pointFromMouse(e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const mouseX = (e.clientX - rect.left) * scaleX;
  const mouseY = (e.clientY - rect.top) * scaleY;
  return {
    mouseX,
    mouseY,
    cellX: Math.floor(mouseX / PIXELS_PER_METER),
    cellY: Math.floor(mouseY / PIXELS_PER_METER)
  };
}
function edgeKeyFromCells(a, b) {
  const aKey = `${a.x},${a.y}`;
  const bKey = `${b.x},${b.y}`;
  return aKey < bKey ? `${aKey}|${bKey}` : `${bKey}|${aKey}`;
}
function edgeId(a, b) {
  if (a.y === b.y && a.x !== b.x) {
    return `V:${Math.max(a.x, b.x)}:${a.y}`;
  }
  if (a.x === b.x && a.y !== b.y) {
    return `H:${a.x}:${Math.max(a.y, b.y)}`;
  }
  return null;
}
function parseEdgeId(id) {
  const parts = id.split(':');
  if (parts.length !== 3) return null;
  const axis = parts[0];
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !['V', 'H'].includes(axis)) return null;
  return { axis, x, y };
}
function allRoomBoundaryWalls() {
  const set = new Set();
  rooms.forEach(room => {
    for (let i = 0; i < room.w; i++) {
      set.add(`H:${room.x + i}:${room.y}`);
      set.add(`H:${room.x + i}:${room.y + room.h}`);
    }
    for (let j = 0; j < room.h; j++) {
      set.add(`V:${room.x}:${room.y + j}`);
      set.add(`V:${room.x + room.w}:${room.y + j}`);
    }
  });
  return set;
}
function allWalls() {
  const result = allRoomBoundaryWalls();
  manualWalls.forEach(id => result.add(id));
  return result;
}
function isWall(id) {
  return allWalls().has(id);
}
function isBlockedBetween(a, b) {
  const id = edgeId(a, b);
  if (!id) return true;
  if (!isWall(id)) return false;
  return !doors.has(id);
}
function snapBoundary(mouseX, mouseY) {
  const gx = mouseX / PIXELS_PER_METER;
  const gy = mouseY / PIXELS_PER_METER;
  const nearestVertical = Math.abs(gx - Math.round(gx));
  const nearestHorizontal = Math.abs(gy - Math.round(gy));
  const threshold = 0.18;
  if (nearestVertical <= nearestHorizontal && nearestVertical <= threshold) {
    const x = Math.round(gx);
    const y = Math.floor(gy);
    if (y >= 0 && y < rows) return `V:${x}:${y}`;
  }
  if (nearestHorizontal <= threshold) {
    const x = Math.floor(gx);
    const y = Math.round(gy);
    if (x >= 0 && x < cols) return `H:${x}:${y}`;
  }
  return null;
}
function editGeometryAt(mouseX, mouseY) {
  const id = snapBoundary(mouseX, mouseY);
  if (!id) {
    if (statsEl) statsEl.innerText = 'Выберите сегмент линии сетки.';
    return;
  }
  if (currentTool === 'wall') {
    if (doors.has(id)) doors.delete(id);
    if (!allRoomBoundaryWalls().has(id)) {
      manualWalls.add(id);
      showStatus('Дополнительная стена добавлена.');
    } else {
      showStatus('Граница комнаты уже является стеной.');
    }
  }
  if (currentTool === 'door') {
    if (!isWall(id)) {
      showStatus('Дверь можно поставить только на существующей стене.');
      return;
    }
    doors.add(id);
    showStatus('Дверной проём добавлен.');
  }
  if (currentTool === 'erase') {
    if (doors.delete(id)) {
      showStatus('Дверь удалена.');
    } else if (manualWalls.delete(id)) {
      showStatus('Дополнительная стена удалена.');
    } else if (allRoomBoundaryWalls().has(id)) {
      showStatus('Границы комнат формируются автоматически и не удаляются ластиком.');
    } else {
      showStatus('Здесь нет стены или двери.');
    }
  }
  cleanupDoors();
  resetNetworkCables();
  draw();
}
function showStatus(message) {
  if (statsEl) statsEl.innerText = message;
}
function cleanupDoors() {
  const walls = allWalls();
  doors.forEach(id => {
    if (!walls.has(id)) doors.delete(id);
  });
}
function moveEdgeId(id, dx, dy) {
  const parsed = parseEdgeId(id);
  if (!parsed) return id;
  return `${parsed.axis}:${parsed.x + dx}:${parsed.y + dy}`;
}
function moveAttachedDoors(selectedRooms, dx, dy) {
  const sourceDoors = dragStartDoors ? new Set(dragStartDoors) : new Set(doors);
  const oldBoundary = new Set();
  selectedRooms.forEach(room => {
    const ox = room.origX ?? room.x;
    const oy = room.origY ?? room.y;
    for (let i = 0; i < room.w; i++) {
      oldBoundary.add(`H:${ox + i}:${oy}`);
      oldBoundary.add(`H:${ox + i}:${oy + room.h}`);
    }
    for (let j = 0; j < room.h; j++) {
      oldBoundary.add(`V:${ox}:${oy + j}`);
      oldBoundary.add(`V:${ox + room.w}:${oy + j}`);
    }
  });
  const moved = new Set();
  sourceDoors.forEach(id => {
    if (oldBoundary.has(id)) moved.add(moveEdgeId(id, dx, dy));
    else moved.add(id);
  });
  doors = moved;
}
function findFreeCellInRoom(room) {
  for (let y = 0; y < room.h; y++) {
    for (let x = 0; x < room.w; x++) {
      const occupiedByDevice = room.devices.some(d => d.localX === x && d.localY === y);
      const occupiedBySwitch = room.switchLocalX === x && room.switchLocalY === y;
      if (!occupiedByDevice && !occupiedBySwitch) return { x, y };
    }
  }
  return null;
}
function findCentralSwitchPosition() {
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (!rooms.some(room => roomContainsCell(room, x, y))) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}
function ensureCentralSwitch() {
  if (!centralSwitch || rooms.some(room => roomContainsCell(room, centralSwitch.x, centralSwitch.y))) {
    const pos = findCentralSwitchPosition();
    centralSwitch = { x: pos.x, y: pos.y };
  }
}
function canvasMouseDown(e) {
  const { mouseX, mouseY, cellX, cellY } = pointFromMouse(e);
  if (currentTool !== 'select') {
    editGeometryAt(mouseX, mouseY);
    return;
  }
  // Room settings button.
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i];
    const rx = room.x * PIXELS_PER_METER;
    const ry = room.y * PIXELS_PER_METER;
    const rw = room.w * PIXELS_PER_METER;
    if (mouseX >= rx + rw - 24 && mouseX <= rx + rw && mouseY >= ry && mouseY <= ry + 24) {
      openModal(room);
      return;
    }
  }
  // Resize handle.
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i];
    const rx = room.x * PIXELS_PER_METER;
    const ry = room.y * PIXELS_PER_METER;
    const rw = room.w * PIXELS_PER_METER;
    const rh = room.h * PIXELS_PER_METER;
    if (mouseX >= rx + rw - 16 && mouseX <= rx + rw && mouseY >= ry + rh - 16 && mouseY <= ry + rh) {
      actionState = 'resize';
      targetRoom = room;
      return;
    }
  }
  if (centralSwitch && cellX === centralSwitch.x && cellY === centralSwitch.y) {
    actionState = 'drag_switch';
    dragOffsetX = mouseX - centralSwitch.x * PIXELS_PER_METER;
    dragOffsetY = mouseY - centralSwitch.y * PIXELS_PER_METER;
    return;
  }
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i];
    if (networkGenerated && room.switchLocalX !== undefined && cellX === room.x + room.switchLocalX && cellY === room.y + room.switchLocalY) {
      actionState = 'drag_local_switch';
      targetRoom = room;
      dragOffsetX = mouseX - (room.x + room.switchLocalX) * PIXELS_PER_METER;
      dragOffsetY = mouseY - (room.y + room.switchLocalY) * PIXELS_PER_METER;
      return;
    }
    for (const device of room.devices) {
      if (cellX === room.x + device.localX && cellY === room.y + device.localY) {
        actionState = 'drag_device';
        targetRoom = room;
        targetDevice = device;
        dragOffsetX = mouseX - (room.x + device.localX) * PIXELS_PER_METER;
        dragOffsetY = mouseY - (room.y + device.localY) * PIXELS_PER_METER;
        return;
      }
    }
  }
  for (let i = rooms.length - 1; i >= 0; i--) {
    const room = rooms[i];
    if (roomContainsCell(room, cellX, cellY)) {
      actionState = 'drag';
      targetRoom = room;
      if (e.shiftKey) {
        room.selected = !room.selected;
      } else if (!room.selected) {
        rooms.forEach(r => r.selected = false);
        room.selected = true;
      }
      initialMousePos = { x: cellX, y: cellY };
      rooms.forEach(r => {
        if (r.selected) {
          r.origX = r.x;
          r.origY = r.y;
        }
      });
      dragStartDoors = new Set(doors);
      return;
    }
  }
  if (!e.shiftKey) rooms.forEach(room => room.selected = false);
  actionState = 'select';
  selectionBox = { startX: mouseX, startY: mouseY, w: 0, h: 0 };
  draw();
}
function canvasMouseMove(e) {
  const { mouseX, mouseY, cellX, cellY } = pointFromMouse(e);
  if (actionState === 'select' && selectionBox) {
    selectionBox.w = mouseX - selectionBox.startX;
    selectionBox.h = mouseY - selectionBox.startY;
    draw();
    return;
  }
  if (!actionState) {
    if (currentTool !== 'select') {
      canvas.style.cursor = 'crosshair';
      return;
    }
    let hoverAction = 'default';
    for (let i = rooms.length - 1; i >= 0; i--) {
      const room = rooms[i];
      const rx = room.x * PIXELS_PER_METER;
      const ry = room.y * PIXELS_PER_METER;
      const rw = room.w * PIXELS_PER_METER;
      const rh = room.h * PIXELS_PER_METER;
      if (mouseX >= rx + rw - 24 && mouseX <= rx + rw && mouseY >= ry && mouseY <= ry + 24) { hoverAction = 'pointer'; break; }
      if (mouseX >= rx + rw - 16 && mouseX <= rx + rw && mouseY >= ry + rh - 16 && mouseY <= ry + rh) { hoverAction = 'se-resize'; break; }
      if (networkGenerated && room.switchLocalX !== undefined && cellX === room.x + room.switchLocalX && cellY === room.y + room.switchLocalY) { hoverAction = 'move'; break; }
      if (room.devices.some(d => cellX === room.x + d.localX && cellY === room.y + d.localY)) { hoverAction = 'move'; break; }
      if (roomContainsCell(room, cellX, cellY)) { hoverAction = 'move'; break; }
    }
    if (hoverAction === 'default' && centralSwitch && cellX === centralSwitch.x && cellY === centralSwitch.y) hoverAction = 'move';
    canvas.style.cursor = hoverAction;
    return;
  }
  canvas.style.cursor = 'move';
  if (actionState === 'drag_switch') {
    centralSwitch.dragPixelX = mouseX - dragOffsetX;
    centralSwitch.dragPixelY = mouseY - dragOffsetY;
    draw();
    return;
  }
  if (actionState === 'drag_device') {
    targetDevice.dragPixelX = mouseX - dragOffsetX;
    targetDevice.dragPixelY = mouseY - dragOffsetY;
    draw();
    return;
  }
  if (actionState === 'drag_local_switch') {
    targetRoom.switchDragPixelX = mouseX - dragOffsetX;
    targetRoom.switchDragPixelY = mouseY - dragOffsetY;
    draw();
    return;
  }
  if (actionState === 'drag') {
    const dx = cellX - initialMousePos.x;
    const dy = cellY - initialMousePos.y;
    const selectedRooms = rooms.filter(room => room.selected);
    if (!selectedRooms.length) return;
    const minDx = -Math.min(...selectedRooms.map(room => room.origX));
    const maxDx = cols - Math.max(...selectedRooms.map(room => room.origX + room.w));
    const minDy = -Math.min(...selectedRooms.map(room => room.origY));
    const maxDy = rows - Math.max(...selectedRooms.map(room => room.origY + room.h));
    const boundedDx = Math.max(minDx, Math.min(maxDx, dx));
    const boundedDy = Math.max(minDy, Math.min(maxDy, dy));
    selectedRooms.forEach(room => {
      room.x = room.origX + boundedDx;
      room.y = room.origY + boundedDy;
    });
    moveAttachedDoors(selectedRooms, boundedDx, boundedDy);
    cleanupDoors();
    if (networkGenerated) generateNetwork(); else draw();
    return;
  }
  if (actionState === 'resize') {
    canvas.style.cursor = 'se-resize';
    const oldW = targetRoom.w;
    const oldH = targetRoom.h;
    targetRoom.w = Math.max(2, cellX - targetRoom.x + 1);
    targetRoom.h = Math.max(2, cellY - targetRoom.y + 1);
    targetRoom.w = Math.min(cols - targetRoom.x, targetRoom.w);
    targetRoom.h = Math.min(rows - targetRoom.y, targetRoom.h);
    targetRoom.devices.forEach(device => {
      device.localX = Math.min(device.localX, targetRoom.w - 1);
      device.localY = Math.min(device.localY, targetRoom.h - 1);
    });
    if (targetRoom.switchLocalX !== undefined) {
      if (targetRoom.switchLocalX >= targetRoom.w || targetRoom.switchLocalY >= targetRoom.h) {
        delete targetRoom.switchLocalX;
        delete targetRoom.switchLocalY;
      }
    }
    if (oldW !== targetRoom.w || oldH !== targetRoom.h) cleanupDoors();
    if (networkGenerated) generateNetwork(); else draw();
  }
}
function finishMouseAction() {
  if (actionState === 'drag_device') {
    let newLx = Math.round(targetDevice.dragPixelX / PIXELS_PER_METER) - targetRoom.x;
    let newLy = Math.round(targetDevice.dragPixelY / PIXELS_PER_METER) - targetRoom.y;
    newLx = Math.max(0, Math.min(targetRoom.w - 1, newLx));
    newLy = Math.max(0, Math.min(targetRoom.h - 1, newLy));
    const occupied = targetRoom.devices.some(d => d !== targetDevice && d.localX === newLx && d.localY === newLy)
      || (networkGenerated && targetRoom.switchLocalX === newLx && targetRoom.switchLocalY === newLy);
    if (!occupied) {
      targetDevice.localX = newLx;
      targetDevice.localY = newLy;
    }
    delete targetDevice.dragPixelX;
    delete targetDevice.dragPixelY;
    if (networkGenerated) generateNetwork(); else draw();
  }
  if (actionState === 'drag_local_switch') {
    let newLx = Math.round(targetRoom.switchDragPixelX / PIXELS_PER_METER) - targetRoom.x;
    let newLy = Math.round(targetRoom.switchDragPixelY / PIXELS_PER_METER) - targetRoom.y;
    newLx = Math.max(0, Math.min(targetRoom.w - 1, newLx));
    newLy = Math.max(0, Math.min(targetRoom.h - 1, newLy));
    if (!targetRoom.devices.some(d => d.localX === newLx && d.localY === newLy)) {
      targetRoom.switchLocalX = newLx;
      targetRoom.switchLocalY = newLy;
    }
    delete targetRoom.switchDragPixelX;
    delete targetRoom.switchDragPixelY;
    if (networkGenerated) generateNetwork(); else draw();
  }
  if (actionState === 'drag_switch') {
    centralSwitch.x = Math.max(0, Math.min(cols - 1, Math.round(centralSwitch.dragPixelX / PIXELS_PER_METER)));
    centralSwitch.y = Math.max(0, Math.min(rows - 1, Math.round(centralSwitch.dragPixelY / PIXELS_PER_METER)));
    delete centralSwitch.dragPixelX;
    delete centralSwitch.dragPixelY;
    if (rooms.some(room => roomContainsCell(room, centralSwitch.x, centralSwitch.y))) {
      const pos = findCentralSwitchPosition();
      centralSwitch.x = pos.x;
      centralSwitch.y = pos.y;
    }
    if (networkGenerated) generateNetwork(); else draw();
  }
  if (actionState === 'select' && selectionBox) {
    const boxX = Math.min(selectionBox.startX, selectionBox.startX + selectionBox.w);
    const boxY = Math.min(selectionBox.startY, selectionBox.startY + selectionBox.h);
    const boxW = Math.abs(selectionBox.w);
    const boxH = Math.abs(selectionBox.h);
    rooms.forEach(room => {
      const rx = room.x * PIXELS_PER_METER;
      const ry = room.y * PIXELS_PER_METER;
      const rw = room.w * PIXELS_PER_METER;
      const rh = room.h * PIXELS_PER_METER;
      if (rx < boxX + boxW && rx + rw > boxX && ry < boxY + boxH && ry + rh > boxY) room.selected = true;
    });
    selectionBox = null;
    draw();
  }
  actionState = null;
  targetRoom = null;
  targetDevice = null;
  dragStartDoors = null;
  canvas.style.cursor = currentTool === 'select' ? 'default' : 'crosshair';
}
function openModal(room) {
  activeRoomForModal = room;
  document.getElementById('modPc').value = room.devices.filter(d => d.type === 'pc').length;
  document.getElementById('modPrinter').value = room.devices.filter(d => d.type === 'printer').length;
  document.getElementById('modCamera').value = room.devices.filter(d => d.type === 'camera').length;
  document.getElementById('modWifi').value = room.devices.filter(d => d.type === 'wifi').length;
  modal.style.display = 'flex';
}
function closeModal() {
  modal.style.display = 'none';
  activeRoomForModal = null;
}
function saveModal() {
  if (!activeRoomForModal) return;
  syncDevices(activeRoomForModal, 'pc', parseInt(document.getElementById('modPc').value, 10) || 0);
  syncDevices(activeRoomForModal, 'printer', parseInt(document.getElementById('modPrinter').value, 10) || 0);
  syncDevices(activeRoomForModal, 'camera', parseInt(document.getElementById('modCamera').value, 10) || 0);
  syncDevices(activeRoomForModal, 'wifi', parseInt(document.getElementById('modWifi').value, 10) || 0);
  closeModal();
  if (networkGenerated) generateNetwork(); else draw();
}
function syncDevices(room, type, desiredCount) {
  desiredCount = Math.max(0, Math.floor(desiredCount));
  const currentCount = room.devices.filter(d => d.type === type).length;
  const diff = desiredCount - currentCount;
  if (diff > 0) {
    for (let k = 0; k < diff; k++) {
      const cell = findFreeCellInRoom(room);
      if (!cell) {
        alert('В комнате больше нет свободного места.');
        break;
      }
      room.devices.push({ type, localX: cell.x, localY: cell.y });
    }
  } else if (diff < 0) {
    let removed = 0;
    for (let i = room.devices.length - 1; i >= 0; i--) {
      if (room.devices[i].type === type) {
        room.devices.splice(i, 1);
        removed++;
        if (removed === Math.abs(diff)) break;
      }
    }
  }
}
function generateNetwork() {
  if (!rooms.length) {
    showStatus('Сначала добавьте хотя бы одну комнату.');
    draw();
    return;
  }
  ensureCentralSwitch();
  cleanupDoors();
  cables = [];
  localSwitches = [];
  unreachableConnections = 0;
  lastCableLength = 0;
  let connectedNodes = 0;
  let totalCableEdges = 0;
  rooms.forEach(room => {
    const devices = room.devices;
    if (!devices.length) {
      delete room.switchLocalX;
      delete room.switchLocalY;
      return;
    }
    if (devices.length >= 3) {
      const invalidLocalSwitch = room.switchLocalX === undefined
        || room.switchLocalY === undefined
        || room.switchLocalX >= room.w
        || room.switchLocalY >= room.h
        || devices.some(d => d.localX === room.switchLocalX && d.localY === room.switchLocalY);
      if (invalidLocalSwitch) {
        const cell = findFreeCellInRoom(room);
        if (cell) {
          room.switchLocalX = cell.x;
          room.switchLocalY = cell.y;
        } else {
          delete room.switchLocalX;
          delete room.switchLocalY;
        }
      }
      if (room.switchLocalX !== undefined) {
        const poeDevices = devices.filter(d => d.type === 'camera' || d.type === 'wifi').length;
        const localSwitch = {
          x: room.x + room.switchLocalX,
          y: room.y + room.switchLocalY,
          isPoe: poeDevices > 0,
          room
        };
        localSwitches.push(localSwitch);
        devices.forEach(device => {
          const path = findPath(localSwitch, { x: room.x + device.localX, y: room.y + device.localY });
          if (path.length) {
            cables.push(path);
            const edges = Math.max(0, path.length - 1);
            totalCableEdges += edges;
            connectedNodes++;
          } else {
            unreachableConnections++;
          }
        });
        const uplink = findPath(centralSwitch, localSwitch);
        if (uplink.length) {
          cables.push(uplink);
          totalCableEdges += Math.max(0, uplink.length - 1);
        } else {
          unreachableConnections++;
        }
      }
    } else {
      delete room.switchLocalX;
      delete room.switchLocalY;
      devices.forEach(device => {
        const path = findPath(centralSwitch, { x: room.x + device.localX, y: room.y + device.localY });
        if (path.length) {
          cables.push(path);
          totalCableEdges += Math.max(0, path.length - 1);
          connectedNodes++;
        } else {
          unreachableConnections++;
        }
      });
    }
  });
  networkGenerated = true;
  lastCableLength = totalCableEdges;
  const unreachableText = unreachableConnections ? ` | Недоступно: ${unreachableConnections}` : '';
  statsEl.innerText = `Подключено узлов: ${connectedNodes} | Коммутаторов: ${localSwitches.length} | Кабель: ~${totalCableEdges} м${unreachableText}`;
  draw();
}
function findPath(start, end) {
  const startCell = { x: start.x, y: start.y };
  const endCell = { x: end.x, y: end.y };
  const queue = [startCell];
  let head = 0;
  const visited = new Set([`${startCell.x},${startCell.y}`]);
  const cameFrom = new Map();
  while (head < queue.length) {
    const current = queue[head++];
    if (current.x === endCell.x && current.y === endCell.y) {
      const path = [];
      let cursor = current;
      while (cursor) {
        path.push(cursor);
        cursor = cameFrom.get(`${cursor.x},${cursor.y}`);
      }
      return path.reverse();
    }
    const neighbors = [
      { x: current.x, y: current.y - 1 },
      { x: current.x, y: current.y + 1 },
      { x: current.x - 1, y: current.y },
      { x: current.x + 1, y: current.y }
    ];
    for (const next of neighbors) {
      if (next.x < 0 || next.x >= cols || next.y < 0 || next.y >= rows) continue;
      if (isBlockedBetween(current, next)) continue;
      const key = `${next.x},${next.y}`;
      if (visited.has(key)) continue;
      visited.add(key);
      cameFrom.set(key, current);
      queue.push(next);
    }
  }
  return [];
}
function drawDeviceVector(type, x, y, size) {
  const s = size / 2;
  const cx = x + s;
  const cy = y + s;
  if (type === 'pc') {
    ctx.fillStyle = '#2c3e50';
    ctx.fillRect(cx - s * 0.6, cy - s * 0.5, s * 1.2, s * 0.8);
    ctx.fillStyle = '#3498db';
    ctx.fillRect(cx - s * 0.5, cy - s * 0.4, s, s * 0.6);
    ctx.fillStyle = '#2c3e50';
    ctx.fillRect(cx - s * 0.15, cy + s * 0.3, s * 0.3, s * 0.3);
    ctx.fillRect(cx - s * 0.4, cy + s * 0.5, s * 0.8, s * 0.15);
  } else if (type === 'printer') {
    ctx.fillStyle = '#7f8c8d';
    ctx.fillRect(cx - s * 0.6, cy - s * 0.3, s * 1.2, s * 0.7);
    ctx.fillStyle = '#fff';
    ctx.fillRect(cx - s * 0.4, cy - s * 0.6, s * 0.8, s * 0.3);
    ctx.fillRect(cx - s * 0.4, cy + s * 0.2, s * 0.8, s * 0.4);
  } else if (type === 'camera') {
    ctx.fillStyle = '#bdc3c7';
    ctx.beginPath();
    ctx.arc(cx, cy + s * 0.2, s * 0.6, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#34495e';
    ctx.fillRect(cx - s * 0.7, cy + s * 0.2, s * 1.4, s * 0.2);
    ctx.fillStyle = '#e74c3c';
    ctx.beginPath();
    ctx.arc(cx, cy - s * 0.1, s * 0.25, 0, Math.PI * 2);
    ctx.fill();
  } else if (type === 'wifi') {
    ctx.strokeStyle = '#e67e22';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy + s * 0.5, s * 0.15, 0, Math.PI * 2);
    ctx.fillStyle = '#e67e22';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy + s * 0.5, s * 0.5, Math.PI + Math.PI / 4, Math.PI * 2 - Math.PI / 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + s * 0.5, s * 0.9, Math.PI + Math.PI / 4, Math.PI * 2 - Math.PI / 4);
    ctx.stroke();
  }
}
function drawSwitchVector(type, x, y, size) {
  const s = size / 2;
  const cx = x + s;
  const cy = y + s;
  if (type === 'core') {
    ctx.fillStyle = '#2c3e50';
    ctx.fillRect(cx - s * 0.8, cy - s * 0.8, s * 1.6, s * 1.6);
    ctx.fillStyle = '#ecf0f1';
    ctx.font = 'bold 12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CORE', cx, cy);
  } else {
    ctx.fillStyle = type === 'poe' ? '#8e44ad' : '#27ae60';
    ctx.fillRect(cx - s * 0.7, cy - s * 0.7, s * 1.4, s * 1.4);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(type === 'poe' ? 'PoE' : 'SW', cx, cy);
  }
}
function drawGrid() {
  ctx.strokeStyle = 'rgba(238, 238, 238, 0.45)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= cols; x++) {
    ctx.beginPath();
    ctx.moveTo(x * PIXELS_PER_METER, 0);
    ctx.lineTo(x * PIXELS_PER_METER, canvas.height);
    ctx.stroke();
  }
  for (let y = 0; y <= rows; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * PIXELS_PER_METER);
    ctx.lineTo(canvas.width, y * PIXELS_PER_METER);
    ctx.stroke();
  }
}
function drawRooms() {
  rooms.forEach(room => {
    const rx = room.x * PIXELS_PER_METER;
    const ry = room.y * PIXELS_PER_METER;
    const rw = room.w * PIXELS_PER_METER;
    const rh = room.h * PIXELS_PER_METER;
    ctx.fillStyle = room.selected ? 'rgba(255, 204, 204, 0.32)' : 'rgba(173, 216, 230, 0.28)';
    ctx.fillRect(rx, ry, rw, rh);
    ctx.strokeStyle = room.selected ? '#ff4757' : '#4682B4';
    ctx.lineWidth = room.selected ? 3 : 2;
    ctx.strokeRect(rx, ry, rw, rh);
    ctx.lineWidth = 1;
    ctx.fillStyle = '#34495e';
    ctx.fillRect(rx + rw - 24, ry, 24, 24);
    ctx.fillStyle = '#fff';
    ctx.font = '14px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⚙️', rx + rw - 12, ry + 12);
    ctx.fillStyle = '#2c3e50';
    ctx.fillRect(rx + rw - 14, ry + rh - 14, 14, 14);
    ctx.fillStyle = '#34495e';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`${room.w} × ${room.h} м`, rx + 6, ry + 5);
  });
}
function drawWalls() {
  const boundaryWalls = allRoomBoundaryWalls();
  const walls = allWalls();
  ctx.lineCap = 'square';
  walls.forEach(id => {
    const parsed = parseEdgeId(id);
    if (!parsed) return;
    const isDoor = doors.has(id);
    const isAutomatic = boundaryWalls.has(id);
    const isManual = manualWalls.has(id);
    if (parsed.axis === 'V') {
      const x = parsed.x * PIXELS_PER_METER;
      const y1 = parsed.y * PIXELS_PER_METER;
      const y2 = (parsed.y + 1) * PIXELS_PER_METER;
      if (isDoor) {
        ctx.strokeStyle = '#27ae60';
        ctx.lineWidth = 8;
      } else {
        ctx.strokeStyle = isAutomatic ? '#2f3542' : '#7f8c8d';
        ctx.lineWidth = isAutomatic ? 5 : 3;
      }
      ctx.beginPath();
      ctx.moveTo(x, y1);
      ctx.lineTo(x, y2);
      ctx.stroke();
    } else {
      const y = parsed.y * PIXELS_PER_METER;
      const x1 = parsed.x * PIXELS_PER_METER;
      const x2 = (parsed.x + 1) * PIXELS_PER_METER;
      if (isDoor) {
        ctx.strokeStyle = '#27ae60';
        ctx.lineWidth = 8;
      } else {
        ctx.strokeStyle = isAutomatic ? '#2f3542' : '#7f8c8d';
        ctx.lineWidth = isAutomatic ? 5 : 3;
      }
      ctx.beginPath();
      ctx.moveTo(x1, y);
      ctx.lineTo(x2, y);
      ctx.stroke();
    }
    if (isDoor) {
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 12px Arial';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (parsed.axis === 'V') ctx.fillText('D', parsed.x * PIXELS_PER_METER, (parsed.y + 0.5) * PIXELS_PER_METER);
      else ctx.fillText('D', (parsed.x + 0.5) * PIXELS_PER_METER, parsed.y * PIXELS_PER_METER);
    }
    void isManual;
  });
  ctx.lineWidth = 1;
}
function drawCables() {
  ctx.strokeStyle = '#ff9f43';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  cables.forEach(path => {
    if (!path.length) return;
    ctx.beginPath();
    ctx.moveTo(path[0].x * PIXELS_PER_METER + PIXELS_PER_METER / 2, path[0].y * PIXELS_PER_METER + PIXELS_PER_METER / 2);
    for (const point of path.slice(1)) {
      ctx.lineTo(point.x * PIXELS_PER_METER + PIXELS_PER_METER / 2, point.y * PIXELS_PER_METER + PIXELS_PER_METER / 2);
    }
    ctx.stroke();
  });
  ctx.lineWidth = 1;
}
function drawEquipment() {
  localSwitches.forEach(sw => {
    const px = sw.room.switchDragPixelX !== undefined ? sw.room.switchDragPixelX : sw.x * PIXELS_PER_METER;
    const py = sw.room.switchDragPixelY !== undefined ? sw.room.switchDragPixelY : sw.y * PIXELS_PER_METER;
    drawSwitchVector(sw.isPoe ? 'poe' : 'sw', px, py, PIXELS_PER_METER);
  });
  if (centralSwitch) {
    const px = centralSwitch.dragPixelX !== undefined ? centralSwitch.dragPixelX : centralSwitch.x * PIXELS_PER_METER;
    const py = centralSwitch.dragPixelY !== undefined ? centralSwitch.dragPixelY : centralSwitch.y * PIXELS_PER_METER;
    drawSwitchVector('core', px, py, PIXELS_PER_METER);
  }
  rooms.forEach(room => {
    room.devices.forEach(device => {
      const px = device.dragPixelX !== undefined ? device.dragPixelX : (room.x + device.localX) * PIXELS_PER_METER;
      const py = device.dragPixelY !== undefined ? device.dragPixelY : (room.y + device.localY) * PIXELS_PER_METER;
      drawDeviceVector(device.type, px, py, PIXELS_PER_METER);
    });
  });
}
function drawSelectionBox() {
  if (!selectionBox) return;
  ctx.fillStyle = 'rgba(0, 123, 255, 0.16)';
  ctx.strokeStyle = 'rgba(0, 123, 255, 0.8)';
  ctx.lineWidth = 1;
  ctx.fillRect(selectionBox.startX, selectionBox.startY, selectionBox.w, selectionBox.h);
  ctx.strokeRect(selectionBox.startX, selectionBox.startY, selectionBox.w, selectionBox.h);
}
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  drawRooms();
  drawWalls();
  drawCables();
  drawEquipment();
  drawSelectionBox();
  updateStatsCards();
}
function collectProject() {
  return {
    version: PROJECT_VERSION,
    app: 'Network Planner',
    grid: { pixelsPerMeter: PIXELS_PER_METER, width: canvas.width, height: canvas.height },
    rooms: structuredClone(rooms),
    centralSwitch: structuredClone(centralSwitch),
    manualWalls: [...manualWalls],
    doors: [...doors]
  };
}
function sanitizeProject(data) {
  if (!data || typeof data !== 'object') throw new Error('Некорректный JSON-файл.');
  if (!Array.isArray(data.rooms)) throw new Error('В проекте отсутствует список комнат.');
  return data;
}
function saveProject() {
  const data = collectProject();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = `network-project-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function loadProjectFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = sanitizeProject(JSON.parse(reader.result));
      rooms = structuredClone(data.rooms).map(room => ({
        ...room,
        selected: false,
        devices: Array.isArray(room.devices) ? room.devices : []
      }));
      rooms.forEach(room => {
        delete room.origX;
        delete room.origY;
      });
      centralSwitch = structuredClone(data.centralSwitch ?? null);
      manualWalls = new Set(Array.isArray(data.manualWalls) ? data.manualWalls : []);
      doors = new Set(Array.isArray(data.doors) ? data.doors : []);
      cleanupDoors();
      resetNetworkCables();
      ensureCentralSwitch();
      draw();
      showStatus(`Проект загружен. Версия файла: ${data.version ?? 'не указана'}.`);
    } catch (err) {
      alert(`Не удалось загрузить проект: ${err.message}`);
    } finally {
      event.target.value = '';
    }
  };
  reader.readAsText(file, 'utf-8');
}
function updateStatsCards() {
  const devices = rooms.reduce((sum, room) => sum + room.devices.length, 0);
  const switches = localSwitches.length + (centralSwitch ? 1 : 0);
  const wallCount = allWalls().size;
  const doorCount = doors.size;
  const roomsEl = document.getElementById('statRooms');
  const devicesEl = document.getElementById('statDevices');
  const switchesEl = document.getElementById('statSwitches');
  const cableEl = document.getElementById('statCable');
  const wallsEl = document.getElementById('statWalls');
  const doorsEl = document.getElementById('statDoors');
  if (roomsEl) roomsEl.textContent = rooms.length;
  if (devicesEl) devicesEl.textContent = devices;
  if (switchesEl) switchesEl.textContent = switches;
  if (cableEl) cableEl.textContent = `${lastCableLength} м`;
  if (wallsEl) wallsEl.textContent = wallCount;
  if (doorsEl) doorsEl.textContent = doorCount;
}
window.addRoom = addRoom;
window.addRoomFromToolbar = addRoomFromToolbar;
window.generateNetwork = generateNetwork;
window.setTool = setTool;
window.openModal = openModal;
window.closeModal = closeModal;
window.saveModal = saveModal;
window.clearAll = initGrid;
window.saveProject = saveProject;
window.loadProjectFile = loadProjectFile;
window.updateStatsCards = updateStatsCards;
canvas.addEventListener('mousedown', canvasMouseDown);
window.addEventListener('mousemove', canvasMouseMove);
window.addEventListener('mouseup', finishMouseAction);
setTool('select');
initGrid();

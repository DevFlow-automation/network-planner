'use strict';

const canvas = document.getElementById('grid');
const ctx = canvas.getContext('2d');
const statsEl = document.getElementById('stats');
const modal = document.getElementById('deviceModal');

const PIXELS_PER_METER = 40;
const cols = Math.floor(canvas.width / PIXELS_PER_METER);
const rows = Math.floor(canvas.height / PIXELS_PER_METER);
const PROJECT_VERSION = 7;
const PENETRATION_PENALTY = 18;
const MAX_SWITCH_CANDIDATES = 225;
const ROOM_INTERIOR_STEP_PENALTY = 4;

let rooms = [];
let centralSwitch = null;
let networkEntry = null;
let localSwitches = [];
let cables = [];
let networkGenerated = false;
let unreachableConnections = 0;
let lastCableLength = 0;

let manualWalls = new Set();
let doors = new Set();
let penetrations = new Set();
let suggestedPenetrations = new Set();

let currentTool = 'select';
let actionState = null;
let targetRoom = null;
let targetDevice = null;
let dragOffsetX = 0;
let dragOffsetY = 0;
let initialMousePos = null;
let selectionBox = null;
let activeRoomForModal = null;

const TOOL_HELP = {
    select: 'Выбор: перемещение комнат и оборудования.',
    wall: 'Стена: добавляет дополнительное физическое препятствие.',
    door: 'Дверь: ручной проход через стену. Система сама двери не создаёт.',
    penetration: 'Отверстие: ручная точка прохода кабеля через стену.',
    entry: 'Точка входа: укажите, откуда сеть входит в здание — серверная или роутер провайдера.',
    erase: 'Ластик: удаляет дверь, отверстие или дополнительную стену.'
};

function setTool(tool) {
    if (!Object.prototype.hasOwnProperty.call(TOOL_HELP, tool)) return;
    currentTool = tool;

    document.querySelectorAll('.tool-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tool === tool);
    });

    const help = document.getElementById('toolHelp');
    if (help) help.textContent = TOOL_HELP[tool];

    canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
}

function resetNetworkCables(options = {}) {
    const keepSuggestions = options.keepSuggestions === true;
    cables = [];
    localSwitches = [];
    networkGenerated = false;
    unreachableConnections = 0;
    lastCableLength = 0;
    if (!keepSuggestions) suggestedPenetrations = new Set();
    statsEl.textContent = 'Ожидание генерации...';
    updateStatsCards();
}

function invalidateNetwork() {
    resetNetworkCables();
    draw();
}

function initGrid() {
    rooms = [];
    centralSwitch = null;
    networkEntry = null;
    manualWalls = new Set();
    doors = new Set();
    penetrations = new Set();
    suggestedPenetrations = new Set();
    resetNetworkCables();
    actionState = null;
    targetRoom = null;
    targetDevice = null;
    selectionBox = null;
    activeRoomForModal = null;
    modal.style.display = 'none';
    setTool('select');
    draw();
}

function addRoom() {
    const wInput = document.getElementById('roomW');
    const hInput = document.getElementById('roomH');
    const w = clampInt(Number.parseInt(wInput.value, 10) || 4, 2, 15);
    const h = clampInt(Number.parseInt(hInput.value, 10) || 3, 2, 15);

    const offset = (rooms.length % 3) * 2;
    const room = {
        id: `room-${Date.now()}-${rooms.length}`,
        name: `Комната ${rooms.length + 1}`,
        x: Math.min(2 + offset, cols - w),
        y: Math.min(2 + offset, rows - h),
        w,
        h,
        devices: [],
        selected: true
    };

    rooms.forEach(r => { r.selected = false; });
    rooms.push(room);
    invalidateNetwork();
}

function addRoomFromToolbar() {
    addRoom();
}

function clampInt(value, min, max) {
    return Math.max(min, Math.min(max, Math.round(value)));
}

function getRoomAtCell(x, y) {
    for (let i = rooms.length - 1; i >= 0; i--) {
        const room = rooms[i];
        if (x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) {
            return room;
        }
    }
    return null;
}

function getRoomBoundaryWalls() {
    const result = new Set();

    rooms.forEach(room => {
        for (let x = room.x; x < room.x + room.w; x++) {
            result.add(`H:${x}:${room.y}`);
            result.add(`H:${x}:${room.y + room.h}`);
        }
        for (let y = room.y; y < room.y + room.h; y++) {
            result.add(`V:${room.x}:${y}`);
            result.add(`V:${room.x + room.w}:${y}`);
        }
    });

    return result;
}

function getAllWalls() {
    const walls = getRoomBoundaryWalls();
    manualWalls.forEach(id => walls.add(id));
    return walls;
}

function parseWallId(id) {
    const parts = String(id).split(':');
    if (parts.length !== 3) return null;
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { axis: parts[0], x, y };
}

function getWallIdBetween(a, b) {
    if (a.y === b.y && Math.abs(a.x - b.x) === 1) {
        return `V:${Math.max(a.x, b.x)}:${a.y}`;
    }
    if (a.x === b.x && Math.abs(a.y - b.y) === 1) {
        return `H:${a.x}:${Math.max(a.y, b.y)}`;
    }
    return null;
}

function isBlockedBetween(a, b) {
    const wallId = getWallIdBetween(a, b);
    if (!wallId) return true;

    const walls = getAllWalls();
    if (!walls.has(wallId)) return false;

    return !doors.has(wallId) && !penetrations.has(wallId) && !suggestedPenetrations.has(wallId);
}

function snapWall(mouseX, mouseY) {
    const gx = mouseX / PIXELS_PER_METER;
    const gy = mouseY / PIXELS_PER_METER;
    const nx = Math.round(gx);
    const ny = Math.round(gy);
    const dx = Math.abs(gx - nx);
    const dy = Math.abs(gy - ny);
    const threshold = 0.24;

    if (dx < dy && dx <= threshold && nx >= 0 && nx <= cols && gy >= 0 && gy < rows) {
        return `V:${nx}:${Math.floor(gy)}`;
    }

    if (dy <= threshold && ny >= 0 && ny <= rows && gx >= 0 && gx < cols) {
        return `H:${Math.floor(gx)}:${ny}`;
    }

    return null;
}

function cleanupPassages() {
    const walls = getAllWalls();
    doors.forEach(id => { if (!walls.has(id)) doors.delete(id); });
    penetrations.forEach(id => { if (!walls.has(id)) penetrations.delete(id); });
    suggestedPenetrations.forEach(id => { if (!walls.has(id)) suggestedPenetrations.delete(id); });
}

function editWallAt(mouseX, mouseY) {
    const wallId = snapWall(mouseX, mouseY);
    if (!wallId) {
        statsEl.textContent = 'Нажмите ближе к линии сетки.';
        return;
    }

    const automaticWalls = getRoomBoundaryWalls();
    const existingWalls = getAllWalls();

    if (currentTool === 'wall') {
        if (automaticWalls.has(wallId)) {
            statsEl.textContent = 'Это автоматическая граница комнаты.';
        } else {
            doors.delete(wallId);
            penetrations.delete(wallId);
            suggestedPenetrations.delete(wallId);
            manualWalls.add(wallId);
            statsEl.textContent = 'Дополнительная стена добавлена.';
        }
    } else if (currentTool === 'door') {
        if (!existingWalls.has(wallId)) {
            statsEl.textContent = 'Дверь можно установить только на существующую стену.';
        } else {
            doors.add(wallId);
            penetrations.delete(wallId);
            suggestedPenetrations.delete(wallId);
            statsEl.textContent = 'Дверной проход добавлен вручную.';
        }
    } else if (currentTool === 'penetration') {
        if (!existingWalls.has(wallId)) {
            statsEl.textContent = 'Отверстие можно создать только в существующей стене.';
        } else {
            penetrations.add(wallId);
            doors.delete(wallId);
            suggestedPenetrations.delete(wallId);
            statsEl.textContent = 'Точка прохода кабеля добавлена вручную.';
        }
    } else if (currentTool === 'erase') {
        if (doors.delete(wallId)) {
            statsEl.textContent = 'Дверь удалена.';
        } else if (penetrations.delete(wallId)) {
            statsEl.textContent = 'Отверстие удалено.';
        } else if (manualWalls.delete(wallId)) {
            statsEl.textContent = 'Дополнительная стена удалена.';
        } else if (automaticWalls.has(wallId)) {
            statsEl.textContent = 'Автоматическая граница комнаты не удаляется вручную.';
        } else {
            statsEl.textContent = 'Здесь нет объекта для удаления.';
        }
    }

    cleanupPassages();
    resetNetworkCables();
    draw();
}

function setEntryTypeText() {
    const label = document.getElementById('entryStatus');
    if (!label) return;
    if (!networkEntry) {
        label.textContent = 'Не задана';
        return;
    }
    const typeText = networkEntry.type === 'server' ? 'Серверная' : 'Роутер провайдера';
    const room = networkEntry.roomId ? rooms.find(r => r.id === networkEntry.roomId) : null;
    label.textContent = room ? `${typeText} — ${room.name}` : typeText;
}

function getSelectedEntryType() {
    const select = document.getElementById('entryType');
    return select?.value === 'provider' ? 'provider' : 'server';
}

function placeNetworkEntry(mouseX, mouseY) {
    const pos = {
        x: clampInt(Math.floor(mouseX / PIXELS_PER_METER), 0, cols - 1),
        y: clampInt(Math.floor(mouseY / PIXELS_PER_METER), 0, rows - 1)
    };

    const type = getSelectedEntryType();
    const room = getRoomAtCell(pos.x, pos.y);

    if (type === 'server' && !room) {
        statsEl.textContent = 'Для типа «Серверная» укажите точку внутри комнаты.';
        return;
    }

    networkEntry = {
        type,
        x: pos.x,
        y: pos.y,
        roomId: room?.id ?? null
    };

    centralSwitch = {
        x: pos.x,
        y: pos.y,
        type: type === 'server' ? 'core' : 'router'
    };

    suggestedPenetrations = new Set();
    cables = [];
    localSwitches = [];
    networkGenerated = false;
    unreachableConnections = 0;
    lastCableLength = 0;

    setTool('select');
    setEntryTypeText();
    statsEl.textContent = type === 'server'
        ? `Точка входа задана: серверная (${room.name}).`
        : 'Точка входа задана: роутер провайдера.';
    draw();
}

function clearNetworkEntry() {
    networkEntry = null;
    centralSwitch = null;
    resetNetworkCables();
    setEntryTypeText();
    draw();
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

    syncDevices(activeRoomForModal, 'pc', clampInt(Number.parseInt(document.getElementById('modPc').value, 10) || 0, 0, 999));
    syncDevices(activeRoomForModal, 'printer', clampInt(Number.parseInt(document.getElementById('modPrinter').value, 10) || 0, 0, 999));
    syncDevices(activeRoomForModal, 'camera', clampInt(Number.parseInt(document.getElementById('modCamera').value, 10) || 0, 0, 999));
    syncDevices(activeRoomForModal, 'wifi', clampInt(Number.parseInt(document.getElementById('modWifi').value, 10) || 0, 0, 999));

    closeModal();
    invalidateNetwork();
}

function syncDevices(room, type, desiredCount) {
    const current = room.devices.filter(d => d.type === type).length;
    const diff = desiredCount - current;

    if (diff > 0) {
        for (let k = 0; k < diff; k++) {
            const free = findFreeRoomCell(room);
            if (!free) {
                alert(`В комнате «${room.name}» больше нет свободных клеток.`);
                break;
            }
            room.devices.push({ type, localX: free.x, localY: free.y });
        }
    } else if (diff < 0) {
        let toRemove = Math.abs(diff);
        for (let i = room.devices.length - 1; i >= 0 && toRemove > 0; i--) {
            if (room.devices[i].type === type) {
                room.devices.splice(i, 1);
                toRemove--;
            }
        }
    }
}

function findFreeRoomCell(room) {
    for (let y = 0; y < room.h; y++) {
        for (let x = 0; x < room.w; x++) {
            const usedByDevice = room.devices.some(d => d.localX === x && d.localY === y);
            const usedBySwitch = room.switchLocalX === x && room.switchLocalY === y;
            const usedByEntry = networkEntry && networkEntry.roomId === room.id && networkEntry.x === room.x + x && networkEntry.y === room.y + y;
            if (!usedByDevice && !usedBySwitch && !usedByEntry) return { x, y };
        }
    }
    return null;
}

function ensureEntry() {
    if (!networkEntry) return false;

    networkEntry.x = clampInt(networkEntry.x, 0, cols - 1);
    networkEntry.y = clampInt(networkEntry.y, 0, rows - 1);

    const room = networkEntry.roomId ? rooms.find(r => r.id === networkEntry.roomId) : null;
    if (networkEntry.type === 'server' && !room) {
        networkEntry.roomId = null;
        return false;
    }

    centralSwitch = {
        x: networkEntry.x,
        y: networkEntry.y,
        type: networkEntry.type === 'server' ? 'core' : 'router'
    };
    return true;
}

function calculatePathLength(path) {
    return Math.max(0, path.length - 1);
}

function countNewPenetrations(path) {
    const walls = getAllWalls();
    const ids = new Set();

    for (let i = 1; i < path.length; i++) {
        const wallId = getWallIdBetween(path[i - 1], path[i]);
        if (!wallId) continue;
        if (walls.has(wallId) && !doors.has(wallId) && !penetrations.has(wallId)) {
            ids.add(wallId);
        }
    }

    return ids.size;
}

function isInsideRoom(cell, ignoredRoomIds = new Set()) {
    return rooms.some(room => {
        if (ignoredRoomIds.has(room.id)) return false;
        return (
            cell.x >= room.x && cell.x < room.x + room.w &&
            cell.y >= room.y && cell.y < room.y + room.h
        );
    });
}

function getRoomPerimeterCells(room) {
    const cells = [];
    const seen = new Set();

    for (let x = room.x; x < room.x + room.w; x++) {
        for (const y of [room.y, room.y + room.h - 1]) {
            const key = `${x},${y}`;
            if (!seen.has(key)) {
                seen.add(key);
                cells.push({ x, y });
            }
        }
    }

    for (let y = room.y; y < room.y + room.h; y++) {
        for (const x of [room.x, room.x + room.w - 1]) {
            const key = `${x},${y}`;
            if (!seen.has(key)) {
                seen.add(key);
                cells.push({ x, y });
            }
        }
    }

    return cells;
}

function getRoomBoundaryGateways(room) {
    const gateways = [];
    const walls = getAllWalls();

    function addGateway(wallId, inside, outside) {
        if (
            outside.x < 0 || outside.x >= cols ||
            outside.y < 0 || outside.y >= rows
        ) {
            return;
        }

        // Магистральная трасса не должна заходить в соседнее помещение.
        if (isInsideRoom(outside, new Set([room.id]))) {
            return;
        }

        gateways.push({
            wallId,
            inside,
            outside,
            hasWall: walls.has(wallId),
            hasDoor: doors.has(wallId),
            hasPenetration: penetrations.has(wallId)
        });
    }

    // Верх / низ
    for (let x = room.x; x < room.x + room.w; x++) {
        addGateway(
            `H:${x}:${room.y}`,
            { x, y: room.y },
            { x, y: room.y - 1 }
        );

        addGateway(
            `H:${x}:${room.y + room.h}`,
            { x, y: room.y + room.h - 1 },
            { x, y: room.y + room.h }
        );
    }

    // Лево / право
    for (let y = room.y; y < room.y + room.h; y++) {
        addGateway(
            `V:${room.x}:${y}`,
            { x: room.x, y },
            { x: room.x - 1, y }
        );

        addGateway(
            `V:${room.x + room.w}:${y}`,
            { x: room.x + room.w - 1, y },
            { x: room.x + room.w, y }
        );
    }

    return gateways;
}

function roomPerimeterDistance(a, room) {
    const distances = [
        Math.abs(a.x - room.x),
        Math.abs(a.x - (room.x + room.w - 1)),
        Math.abs(a.y - room.y),
        Math.abs(a.y - (room.y + room.h - 1))
    ];
    return Math.min(...distances);
}

function buildGatewayCablePath(internalPath, gateway, backbonePath) {
    const result = [];

    for (const point of internalPath || []) {
        result.push({ x: point.x, y: point.y });
    }

    const last = result[result.length - 1];
    if (!last || last.x !== gateway.inside.x || last.y !== gateway.inside.y) {
        result.push({ x: gateway.inside.x, y: gateway.inside.y });
    }

    // Переход через физическую стену: от внутренней клетки к внешней.
    result.push({ x: gateway.outside.x, y: gateway.outside.y });

    if (backbonePath?.length) {
        for (let i = 1; i < backbonePath.length; i++) {
            result.push({ x: backbonePath[i].x, y: backbonePath[i].y });
        }
    }

    return result;
}

function getGatewayPenetrationIds(gateway, backbone) {
    const ids = [];

    if (
        gateway?.wallId &&
        !doors.has(gateway.wallId) &&
        !penetrations.has(gateway.wallId) &&
        gateway.hasWall
    ) {
        ids.push(gateway.wallId);
    }

    if (backbone?.suggestedWalls?.length) {
        ids.push(...backbone.suggestedWalls);
    }

    return [...new Set(ids)];
}

function findBackbonePath(start, end) {
    if (start.x === end.x && start.y === end.y) {
        return { path: [start], cost: 0, suggestedWalls: [] };
    }

    const queue = [];
    const distance = new Map();
    const cameFrom = new Map();
    let sequence = 0;

    function push(node, cost) {
        queue.push({ ...node, cost, order: sequence++ });
        queue.sort((a, b) => a.cost - b.cost || a.order - b.order);
    }

    const startKey = `${start.x},${start.y}`;
    distance.set(startKey, 0);
    push(start, 0);

    while (queue.length) {
        const current = queue.shift();
        const currentKey = `${current.x},${current.y}`;
        if (current.cost !== distance.get(currentKey)) continue;

        if (current.x === end.x && current.y === end.y) {
            const path = [];
            let cursor = current;

            while (cursor) {
                path.push({ x: cursor.x, y: cursor.y });
                cursor = cameFrom.get(`${cursor.x},${cursor.y}`);
            }

            path.reverse();

            const suggested = [];
            const walls = getAllWalls();

            for (let i = 1; i < path.length; i++) {
                const wallId = getWallIdBetween(path[i - 1], path[i]);
                if (!wallId) continue;

                if (
                    walls.has(wallId) &&
                    !doors.has(wallId) &&
                    !penetrations.has(wallId)
                ) {
                    suggested.push(wallId);
                }
            }

            return {
                path,
                cost: current.cost,
                suggestedWalls: [...new Set(suggested)]
            };
        }

        const neighbors = [
            { x: current.x, y: current.y - 1 },
            { x: current.x, y: current.y + 1 },
            { x: current.x - 1, y: current.y },
            { x: current.x + 1, y: current.y }
        ];

        for (const next of neighbors) {
            if (
                next.x < 0 || next.x >= cols ||
                next.y < 0 || next.y >= rows
            ) continue;

            const isEndpoint =
                (next.x === start.x && next.y === start.y) ||
                (next.x === end.x && next.y === end.y);

            // Основная магистраль не проходит через внутреннее пространство комнат.
            if (!isEndpoint && isInsideRoom(next)) continue;

            const wallId = getWallIdBetween(current, next);
            if (!wallId) continue;

            const walls = getAllWalls();
            const hasWall = walls.has(wallId);
            const openPassage =
                doors.has(wallId) ||
                penetrations.has(wallId) ||
                suggestedPenetrations.has(wallId);

            const stepCost = 1 + (
                hasWall && !openPassage
                    ? PENETRATION_PENALTY
                    : 0
            );

            const nextCost = current.cost + stepCost;
            const nextKey = `${next.x},${next.y}`;

            if (nextCost < (distance.get(nextKey) ?? Infinity)) {
                distance.set(nextKey, nextCost);
                cameFrom.set(nextKey, current);
                push(next, nextCost);
            }
        }
    }

    return { path: [], cost: Infinity, suggestedWalls: [] };
}

function chooseBestRoomGateway(room, targetPoint) {
    const gateways = getRoomBoundaryGateways(room);
    if (!gateways.length) return null;

    let best = null;

    for (const gateway of gateways) {
        const backbone = findBackbonePath(gateway.outside, targetPoint);
        if (!backbone.path.length) continue;

        let score = backbone.cost * 1.4;
        const devicePaths = [];
        let valid = true;

        for (const device of room.devices) {
            const devicePoint = {
                x: room.x + device.localX,
                y: room.y + device.localY
            };

            const internalPath = findPathRestricted(gateway.inside, devicePoint, room);
            if (!internalPath.length) {
                valid = false;
                break;
            }

            devicePaths.push({ device, path: internalPath });
            score += calculatePathLength(internalPath);
        }

        if (!valid) continue;

        // Небольшое предпочтение прямым проходам через уже существующие двери/отверстия.
        const passagePenalty = gateway.hasDoor || gateway.hasPenetration
            ? 0
            : (gateway.hasWall ? PENETRATION_PENALTY : 0);

        score += passagePenalty;

        if (!best || score < best.score) {
            best = {
                gateway,
                backbone,
                devicePaths,
                score
            };
        }
    }

    return best;
}

function chooseBestEntryGateway(room, entryPoint) {
    const gateways = getRoomBoundaryGateways(room);
    let best = null;

    for (const gateway of gateways) {
        const path = findPathRestricted(entryPoint, gateway.inside, room);
        if (!path.length) continue;

        const score =
            calculatePathLength(path) +
            (gateway.hasDoor || gateway.hasPenetration
                ? 0
                : gateway.hasWall
                    ? PENETRATION_PENALTY
                    : 0);

        if (!best || score < best.score) {
            best = {
                gateway,
                path,
                score
            };
        }
    }

    return best;
}

function isRoomPerimeterCell(room, cell) {
    return (
        cell.x === room.x ||
        cell.x === room.x + room.w - 1 ||
        cell.y === room.y ||
        cell.y === room.y + room.h - 1
    );
}

function findRoomAccessPath(start, end, room) {
    if (start.x === end.x && start.y === end.y) return [start];

    const queue = [];
    const distance = new Map();
    const cameFrom = new Map();
    let sequence = 0;

    function push(node, cost) {
        queue.push({ ...node, cost, order: sequence++ });
        queue.sort((a, b) => a.cost - b.cost || a.order - b.order);
    }

    const startKey = `${start.x},${start.y}`;
    distance.set(startKey, 0);
    push(start, 0);

    while (queue.length) {
        const current = queue.shift();
        const currentKey = `${current.x},${current.y}`;

        if (current.cost !== distance.get(currentKey)) continue;

        if (current.x === end.x && current.y === end.y) {
            const path = [];
            let cursor = current;

            while (cursor) {
                path.push({ x: cursor.x, y: cursor.y });
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
            if (
                next.x < room.x || next.x >= room.x + room.w ||
                next.y < room.y || next.y >= room.y + room.h
            ) {
                continue;
            }

            if (isBlockedBetween(current, next)) continue;

            const key = `${next.x},${next.y}`;

            const interiorPenalty =
                isRoomPerimeterCell(room, next) ? 0 : ROOM_INTERIOR_STEP_PENALTY;

            const nextCost = current.cost + 1 + interiorPenalty;

            if (nextCost < (distance.get(key) ?? Infinity)) {
                distance.set(key, nextCost);
                cameFrom.set(key, current);
                push(next, nextCost);
            }
        }
    }

    return [];
}

// Оставляем старое имя как совместимый алиас.
function findPathRestricted(start, end, room) {
    return findRoomAccessPath(start, end, room);
}

function findWeightedPath(start, end) {
    if (start.x === end.x && start.y === end.y) {
        return { path: [start], cost: 0, suggestedWalls: [] };
    }

    const queue = [];
    const distance = new Map();
    const cameFrom = new Map();
    const sequence = { value: 0 };

    function push(node, cost) {
        queue.push({ ...node, cost, order: sequence.value++ });
        queue.sort((a, b) => a.cost - b.cost || a.order - b.order);
    }

    const startKey = `${start.x},${start.y}`;
    distance.set(startKey, 0);
    push(start, 0);

    while (queue.length) {
        const current = queue.shift();
        const currentKey = `${current.x},${current.y}`;

        if (current.cost !== distance.get(currentKey)) continue;

        if (current.x === end.x && current.y === end.y) {
            const path = [];
            let cursor = current;

            while (cursor) {
                path.push({ x: cursor.x, y: cursor.y });
                cursor = cameFrom.get(`${cursor.x},${cursor.y}`);
            }

            path.reverse();

            const suggested = [];
            const walls = getAllWalls();
            for (let i = 1; i < path.length; i++) {
                const wallId = getWallIdBetween(path[i - 1], path[i]);
                if (!wallId) continue;
                if (
                    walls.has(wallId) &&
                    !doors.has(wallId) &&
                    !penetrations.has(wallId)
                ) {
                    suggested.push(wallId);
                }
            }

            return {
                path,
                cost: current.cost,
                suggestedWalls: [...new Set(suggested)]
            };
        }

        const neighbors = [
            { x: current.x, y: current.y - 1 },
            { x: current.x, y: current.y + 1 },
            { x: current.x - 1, y: current.y },
            { x: current.x + 1, y: current.y }
        ];

        for (const next of neighbors) {
            if (next.x < 0 || next.x >= cols || next.y < 0 || next.y >= rows) continue;

            const wallId = getWallIdBetween(current, next);
            if (!wallId) continue;

            const walls = getAllWalls();
            const hasWall = walls.has(wallId);
            const openPassage = doors.has(wallId) || penetrations.has(wallId) || suggestedPenetrations.has(wallId);

            const stepCost = 1 + (hasWall && !openPassage ? PENETRATION_PENALTY : 0);
            const nextCost = current.cost + stepCost;
            const nextKey = `${next.x},${next.y}`;

            if (nextCost < (distance.get(nextKey) ?? Infinity)) {
                distance.set(nextKey, nextCost);
                cameFrom.set(nextKey, current);
                push(next, nextCost);
            }
        }
    }

    return { path: [], cost: Infinity, suggestedWalls: [] };
}

function chooseBestSwitchLocation(room, targetPoint) {
    const devices = room.devices;
    if (!devices.length) return null;

    const gateways = getRoomBoundaryGateways(room);
    let best = null;

    for (const gateway of gateways) {
        const candidate = gateway.inside;

        if (devices.some(d =>
            d.localX + room.x === candidate.x &&
            d.localY + room.y === candidate.y
        )) {
            continue;
        }

        const devicePaths = [];
        let accessLength = 0;
        let valid = true;

        for (const device of devices) {
            const end = {
                x: room.x + device.localX,
                y: room.y + device.localY
            };

            const path = findPathRestricted(candidate, end, room);
            if (!path.length) {
                valid = false;
                break;
            }

            devicePaths.push({ device, path });
            accessLength += calculatePathLength(path);
        }

        if (!valid) continue;

        // Uplink начинается с внешней стороны стены, а не из центра пограничной клетки комнаты.
        const uplink = findBackbonePath(gateway.outside, targetPoint);
        if (!uplink.path.length) continue;

        const passagePenalty = gateway.hasDoor || gateway.hasPenetration
            ? 0
            : (gateway.hasWall ? PENETRATION_PENALTY : 0);

        const score =
            accessLength +
            uplink.cost * 1.5 +
            passagePenalty;

        if (!best || score < best.score) {
            best = {
                localX: candidate.x - room.x,
                localY: candidate.y - room.y,
                absolute: candidate,
                gateway,
                accessLength,
                devicePaths,
                uplink,
                score
            };
        }
    }

    return best;
}

function applySuggestedWalls(walls) {
    for (const wallId of walls) {
        if (!doors.has(wallId) && !penetrations.has(wallId)) {
            suggestedPenetrations.add(wallId);
        }
    }
}

function shouldUseLocalSwitch(room) {
    if (!room.devices.length) return false;

    // В серверной точке входа устройства подключаются к CORE напрямую.
    if (networkEntry?.type === 'server' && networkEntry.roomId === room.id) {
        return false;
    }

    return room.devices.length >= 3;
}

function generateNetwork() {
    if (!rooms.length) {
        statsEl.textContent = 'Сначала добавьте хотя бы одну комнату.';
        return;
    }

    if (!ensureEntry()) {
        statsEl.textContent = 'Сначала укажите точку входа сети в здание.';
        draw();
        return;
    }

    cables = [];
    localSwitches = [];
    unreachableConnections = 0;
    lastCableLength = 0;
    suggestedPenetrations = new Set();

    const entryPoint = {
        x: networkEntry.x,
        y: networkEntry.y
    };

    const entryRoom = networkEntry.roomId
        ? rooms.find(r => r.id === networkEntry.roomId)
        : null;

    let backboneOrigin = entryPoint;

    // Если сеть входит через серверную, от источника до стены серверной
    // строится короткий внутренний участок, а сама магистраль начинается уже с периметра.
    if (entryRoom) {
        const entryGateway = chooseBestEntryGateway(entryRoom, entryPoint);

        if (entryGateway && entryGateway.path.length) {
            const gatewayPath = buildGatewayCablePath(
                entryGateway.path,
                entryGateway.gateway,
                []
            );

            cables.push({
                path: gatewayPath,
                kind: 'access'
            });

            applySuggestedWalls([entryGateway.gateway.wallId]);
            lastCableLength += calculatePathLength(gatewayPath);
            backboneOrigin = entryGateway.gateway.outside;
        }
    }

    let totalLength = lastCableLength;
    let connectedDevices = 0;

    // В комнате-источнике устройства обслуживаются локально от точки входа.
    if (entryRoom && entryRoom.devices.length) {
        for (const device of entryRoom.devices) {
            const end = {
                x: entryRoom.x + device.localX,
                y: entryRoom.y + device.localY
            };

            const path = findPathRestricted(entryPoint, end, entryRoom);
            if (path.length) {
                cables.push({ path, kind: 'access' });
                totalLength += calculatePathLength(path);
                connectedDevices++;
            } else {
                unreachableConnections++;
            }
        }
    }

    for (const room of rooms) {
        if (!room.devices.length) {
            delete room.switchLocalX;
            delete room.switchLocalY;
            continue;
        }

        if (room === entryRoom) {
            continue;
        }

        if (shouldUseLocalSwitch(room)) {
            const best = chooseBestSwitchLocation(room, backboneOrigin);

            if (!best) {
                delete room.switchLocalX;
                delete room.switchLocalY;
                unreachableConnections += room.devices.length + 1;
                continue;
            }

            room.switchLocalX = best.localX;
            room.switchLocalY = best.localY;

            const poeCount = room.devices.filter(
                d => d.type === 'camera' || d.type === 'wifi'
            ).length;

            localSwitches.push({
                x: best.absolute.x,
                y: best.absolute.y,
                isPoe: poeCount > 0,
                room
            });

            for (const item of best.devicePaths) {
                if (!item.path.length) {
                    unreachableConnections++;
                    continue;
                }

                cables.push({
                    path: item.path,
                    kind: 'access'
                });
                totalLength += calculatePathLength(item.path);
                connectedDevices++;
            }

            if (best.uplink.path.length) {
                applySuggestedWalls(getGatewayPenetrationIds(best.gateway, best.uplink));

                const uplinkPath = buildGatewayCablePath(
                    [],
                    best.gateway,
                    best.uplink.path
                );

                cables.push({
                    path: uplinkPath,
                    kind: 'uplink'
                });
                totalLength += calculatePathLength(uplinkPath);
            } else {
                unreachableConnections++;
            }
        } else {
            delete room.switchLocalX;
            delete room.switchLocalY;

            const gateway = chooseBestRoomGateway(room, backboneOrigin);

            if (!gateway) {
                unreachableConnections += room.devices.length + 1;
                continue;
            }

            for (const item of gateway.devicePaths) {
                if (!item.path.length) {
                    unreachableConnections++;
                    continue;
                }

                cables.push({
                    path: item.path,
                    kind: 'access'
                });
                totalLength += calculatePathLength(item.path);
                connectedDevices++;
            }

            if (gateway.backbone.path.length) {
                applySuggestedWalls(getGatewayPenetrationIds(gateway.gateway, gateway.backbone));

                const uplinkPath = buildGatewayCablePath(
                    [],
                    gateway.gateway,
                    gateway.backbone.path
                );

                cables.push({
                    path: uplinkPath,
                    kind: 'uplink'
                });
                totalLength += calculatePathLength(uplinkPath);
            } else {
                unreachableConnections++;
            }
        }
    }

    networkGenerated = true;
    lastCableLength = totalLength;

    const sourceText = networkEntry.type === 'server'
        ? 'Источник: серверная'
        : 'Источник: роутер провайдера';

    const suggestionText = suggestedPenetrations.size
        ? `Предложено отверстий: ${suggestedPenetrations.size}`
        : 'Новых отверстий не требуется';

    statsEl.textContent = [
        sourceText,
        `Подключено узлов: ${connectedDevices}`,
        `Локальных SW: ${localSwitches.length}`,
        `Кабель: ~${totalLength} м`,
        suggestionText,
        unreachableConnections
            ? `Недоступных соединений: ${unreachableConnections}`
            : 'Все маршруты найдены'
    ].join(' | ');

    updateStatsCards();
    draw();
}

function findPath(start, end) {
    return findWeightedPath(start, end).path;
}

function acceptSuggestedPenetrations() {
    let accepted = 0;
    suggestedPenetrations.forEach(id => {
        if (!penetrations.has(id) && getAllWalls().has(id)) {
            penetrations.add(id);
            accepted++;
        }
    });

    suggestedPenetrations = new Set();

    if (accepted) {
        generateNetwork();
        statsEl.textContent += ` | Отверстий принято: ${accepted}`;
    } else {
        statsEl.textContent = 'Нет новых предложенных отверстий.';
        draw();
    }
}

function clearSuggestedPenetrations() {
    suggestedPenetrations = new Set();
    networkGenerated = false;
    cables = [];
    localSwitches = [];
    lastCableLength = 0;
    statsEl.textContent = 'Предложения отверстий скрыты. Нажмите «Сгенерировать сеть», чтобы построить их снова.';
    updateStatsCards();
    draw();
}

function drawGrid() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = 'rgba(210, 214, 220, 0.65)';
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

        ctx.fillStyle = room.selected ? 'rgba(255, 204, 204, 0.38)' : 'rgba(173, 216, 230, 0.34)';
        ctx.fillRect(rx, ry, rw, rh);

        ctx.strokeStyle = room.selected ? '#ff4757' : '#4682b4';
        ctx.lineWidth = room.selected ? 3 : 2;
        ctx.strokeRect(rx, ry, rw, rh);
        ctx.lineWidth = 1;

        ctx.fillStyle = '#34495e';
        ctx.fillRect(rx, ry, Math.min(150, rw), 22);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px Arial';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(room.name, rx + 7, ry + 11);

        ctx.fillStyle = '#34495e';
        ctx.fillRect(rx + rw - 24, ry, 24, 24);
        ctx.fillStyle = '#ffffff';
        ctx.font = '14px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('⚙️', rx + rw - 12, ry + 12);

        ctx.fillStyle = '#2c3e50';
        ctx.fillRect(rx + rw - 14, ry + rh - 14, 14, 14);
    });
}

function drawWalls() {
    const walls = getAllWalls();

    walls.forEach(id => {
        const wall = parseWallId(id);
        if (!wall) return;

        const isDoor = doors.has(id);
        const isPenetration = penetrations.has(id);
        const isSuggested = suggestedPenetrations.has(id);
        const isAutomatic = getRoomBoundaryWalls().has(id);

        if (isDoor) {
            ctx.strokeStyle = '#27ae60';
            ctx.lineWidth = 8;
        } else if (isPenetration) {
            ctx.strokeStyle = '#f39c12';
            ctx.lineWidth = 7;
        } else if (isSuggested) {
            ctx.strokeStyle = '#f39c12';
            ctx.lineWidth = 6;
            ctx.setLineDash([6, 5]);
        } else if (isAutomatic) {
            ctx.strokeStyle = '#2f3542';
            ctx.lineWidth = 5;
        } else {
            ctx.strokeStyle = '#7f8c8d';
            ctx.lineWidth = 3;
        }

        ctx.beginPath();
        if (wall.axis === 'V') {
            const x = wall.x * PIXELS_PER_METER;
            ctx.moveTo(x, wall.y * PIXELS_PER_METER);
            ctx.lineTo(x, (wall.y + 1) * PIXELS_PER_METER);
        } else {
            const y = wall.y * PIXELS_PER_METER;
            ctx.moveTo(wall.x * PIXELS_PER_METER, y);
            ctx.lineTo((wall.x + 1) * PIXELS_PER_METER, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        if (isDoor || isPenetration || isSuggested) {
            const cx = (wall.axis === 'V' ? wall.x : wall.x + 0.5) * PIXELS_PER_METER;
            const cy = (wall.axis === 'V' ? wall.y + 0.5 : wall.y) * PIXELS_PER_METER;

            ctx.fillStyle = isDoor ? '#27ae60' : '#f39c12';
            ctx.beginPath();
            ctx.arc(cx, cy, 6, 0, Math.PI * 2);
            ctx.fill();

            if (isSuggested) {
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 10px Arial';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText('?', cx, cy);
            }
        }
    });

    ctx.lineWidth = 1;
    ctx.setLineDash([]);
}

function drawEntryPoint() {
    if (!networkEntry) return;

    const px = networkEntry.x * PIXELS_PER_METER + PIXELS_PER_METER / 2;
    const py = networkEntry.y * PIXELS_PER_METER + PIXELS_PER_METER / 2;

    ctx.save();

    if (networkEntry.type === 'server') {
        ctx.fillStyle = '#111827';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.fillRect(px - 14, py - 14, 28, 28);
        ctx.strokeRect(px - 14, py - 14, 28, 28);

        ctx.fillStyle = '#60a5fa';
        for (let row = 0; row < 3; row++) {
            ctx.fillRect(px - 8, py - 8 + row * 7, 16, 3);
        }
    } else {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(px - 8, py - 8);
        ctx.lineTo(px - 12, py - 18);
        ctx.moveTo(px + 8, py - 8);
        ctx.lineTo(px + 12, py - 18);
        ctx.stroke();

        ctx.fillStyle = '#6c5ce7';
        ctx.fillRect(px - 14, py - 7, 28, 18);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(px - 8, py - 2, 4, 3);
        ctx.fillRect(px - 1, py - 2, 4, 3);
        ctx.fillRect(px + 6, py - 2, 4, 3);
        ctx.font = 'bold 8px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('ISP', px, py + 6);
    }

    ctx.restore();
}

function drawCable(path, kind) {
    if (!path || path.length < 2) return;

    ctx.beginPath();
    ctx.strokeStyle = kind === 'uplink' ? '#6c5ce7' : '#ff9f43';
    ctx.lineWidth = kind === 'uplink' ? 4 : 3;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    ctx.moveTo(
        path[0].x * PIXELS_PER_METER + PIXELS_PER_METER / 2,
        path[0].y * PIXELS_PER_METER + PIXELS_PER_METER / 2
    );

    for (let i = 1; i < path.length; i++) {
        ctx.lineTo(
            path[i].x * PIXELS_PER_METER + PIXELS_PER_METER / 2,
            path[i].y * PIXELS_PER_METER + PIXELS_PER_METER / 2
        );
    }

    ctx.stroke();
    ctx.lineWidth = 1;
}

function drawDeviceVector(type, x, y, size) {
    const s = size / 2;
    const cx = x + s;
    const cy = y + s;

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    if (type === 'pc') {
        // Монитор
        ctx.fillStyle = '#1f2937';
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = 2;
        ctx.fillRect(cx - s * 0.68, cy - s * 0.52, s * 1.36, s * 0.82);
        ctx.fillStyle = '#60a5fa';
        ctx.fillRect(cx - s * 0.56, cy - s * 0.40, s * 1.12, s * 0.58);
        // Подставка
        ctx.fillStyle = '#374151';
        ctx.fillRect(cx - s * 0.10, cy + s * 0.30, s * 0.20, s * 0.22);
        ctx.fillRect(cx - s * 0.38, cy + s * 0.50, s * 0.76, s * 0.12);
        ctx.stroke();
    } else if (type === 'printer') {
        // Принтер + лист
        ctx.fillStyle = '#4b5563';
        ctx.strokeStyle = '#1f2937';
        ctx.lineWidth = 2;
        ctx.fillRect(cx - s * 0.70, cy - s * 0.18, s * 1.40, s * 0.62);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(cx - s * 0.45, cy - s * 0.58, s * 0.90, s * 0.50);
        ctx.strokeRect(cx - s * 0.45, cy - s * 0.58, s * 0.90, s * 0.50);
        ctx.fillStyle = '#d1d5db';
        ctx.fillRect(cx - s * 0.42, cy + s * 0.22, s * 0.84, s * 0.34);
        ctx.fillStyle = '#111827';
        ctx.fillRect(cx + s * 0.38, cy - s * 0.02, s * 0.10, s * 0.10);
    } else if (type === 'camera') {
        // Купольная камера
        ctx.fillStyle = '#374151';
        ctx.strokeStyle = '#111827';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.72, cy + s * 0.28);
        ctx.quadraticCurveTo(cx, cy + s * 0.78, cx + s * 0.72, cy + s * 0.28);
        ctx.lineTo(cx + s * 0.55, cy - s * 0.28);
        ctx.quadraticCurveTo(cx, cy - s * 0.60, cx - s * 0.55, cy - s * 0.28);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#111827';
        ctx.beginPath();
        ctx.arc(cx, cy + s * 0.10, s * 0.23, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(cx, cy + s * 0.10, s * 0.09, 0, Math.PI * 2);
        ctx.fill();
    } else if (type === 'wifi') {
        // Круглая точка доступа
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#0f766e';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy + s * 0.22, s * 0.60, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = '#0f766e';
        ctx.beginPath();
        ctx.arc(cx, cy + s * 0.34, s * 0.10, 0, Math.PI * 2);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(cx, cy + s * 0.34, s * 0.30, Math.PI + 0.35, Math.PI * 2 - 0.35);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(cx, cy + s * 0.34, s * 0.48, Math.PI + 0.35, Math.PI * 2 - 0.35);
        ctx.stroke();
    }

    ctx.restore();
}

function drawSwitchVector(type, x, y, size) {
    const s = size / 2;
    const cx = x + s;
    const cy = y + s;

    ctx.save();
    ctx.lineJoin = 'round';

    if (type === 'core') {
        // Серверный/CORE коммутатор: широкий rack-unit
        ctx.fillStyle = '#111827';
        ctx.strokeStyle = '#374151';
        ctx.lineWidth = 2;
        ctx.fillRect(cx - s * 0.78, cy - s * 0.48, s * 1.56, s * 0.96);
        ctx.strokeRect(cx - s * 0.78, cy - s * 0.48, s * 1.56, s * 0.96);

        ctx.fillStyle = '#60a5fa';
        for (let i = 0; i < 6; i++) {
            ctx.beginPath();
            ctx.arc(cx - s * 0.54 + i * s * 0.18, cy + s * 0.16, s * 0.045, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('CORE', cx, cy - s * 0.16);
    } else if (type === 'router') {
        // Роутер провайдера: корпус + две антенны
        ctx.strokeStyle = '#6c5ce7';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(cx - s * 0.44, cy - s * 0.38);
        ctx.lineTo(cx - s * 0.62, cy - s * 0.78);
        ctx.moveTo(cx + s * 0.44, cy - s * 0.38);
        ctx.lineTo(cx + s * 0.62, cy - s * 0.78);
        ctx.stroke();

        ctx.fillStyle = '#6c5ce7';
        ctx.fillRect(cx - s * 0.72, cy - s * 0.34, s * 1.44, s * 0.78);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(cx - s * 0.50, cy - s * 0.14, s * 0.18, s * 0.10);
        ctx.fillRect(cx - s * 0.25, cy - s * 0.14, s * 0.18, s * 0.10);
        ctx.fillRect(cx, cy - s * 0.14, s * 0.18, s * 0.10);
        ctx.font = 'bold 8px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('ISP', cx, cy + s * 0.20);
    } else if (type === 'poe' || type === 'sw') {
        // Локальный коммутатор: rack-unit, PoE отличается молнией
        ctx.fillStyle = type === 'poe' ? '#7c3aed' : '#059669';
        ctx.strokeStyle = type === 'poe' ? '#5b21b6' : '#047857';
        ctx.lineWidth = 2;
        ctx.fillRect(cx - s * 0.76, cy - s * 0.42, s * 1.52, s * 0.84);
        ctx.strokeRect(cx - s * 0.76, cy - s * 0.42, s * 1.52, s * 0.84);

        ctx.fillStyle = '#ffffff';
        for (let i = 0; i < 5; i++) {
            ctx.fillRect(cx - s * 0.54 + i * s * 0.20, cy + s * 0.12, s * 0.10, s * 0.10);
        }

        if (type === 'poe') {
            ctx.beginPath();
            ctx.moveTo(cx + s * 0.40, cy - s * 0.28);
            ctx.lineTo(cx + s * 0.08, cy + s * 0.06);
            ctx.lineTo(cx + s * 0.28, cy + s * 0.06);
            ctx.lineTo(cx + s * 0.02, cy + s * 0.34);
            ctx.lineTo(cx + s * 0.52, cy - s * 0.08);
            ctx.lineTo(cx + s * 0.30, cy - s * 0.08);
            ctx.closePath();
            ctx.fill();
        }

        ctx.font = 'bold 8px Arial';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(type === 'poe' ? 'PoE' : 'SW', cx - s * 0.62, cy - s * 0.16);
    }

    ctx.restore();
}


function drawSelectionBox() {
    if (!selectionBox) return;
    ctx.fillStyle = 'rgba(0, 123, 255, 0.18)';
    ctx.strokeStyle = 'rgba(0, 123, 255, 0.8)';
    ctx.lineWidth = 1;
    ctx.fillRect(selectionBox.startX, selectionBox.startY, selectionBox.w, selectionBox.h);
    ctx.strokeRect(selectionBox.startX, selectionBox.startY, selectionBox.w, selectionBox.h);
}

function draw() {
    drawGrid();
    drawRooms();
    drawWalls();

    cables.forEach(item => drawCable(item.path, item.kind));

    localSwitches.forEach(sw => {
        const px = sw.room.switchDragPixelX !== undefined
            ? sw.room.switchDragPixelX
            : sw.x * PIXELS_PER_METER;
        const py = sw.room.switchDragPixelY !== undefined
            ? sw.room.switchDragPixelY
            : sw.y * PIXELS_PER_METER;
        drawSwitchVector(sw.isPoe ? 'poe' : 'sw', px, py, PIXELS_PER_METER);
    });

    if (centralSwitch) {
        const px = centralSwitch.dragPixelX !== undefined
            ? centralSwitch.dragPixelX
            : centralSwitch.x * PIXELS_PER_METER;
        const py = centralSwitch.dragPixelY !== undefined
            ? centralSwitch.dragPixelY
            : centralSwitch.y * PIXELS_PER_METER;
        drawSwitchVector(centralSwitch.type || 'core', px, py, PIXELS_PER_METER);
    }

    rooms.forEach(room => {
        room.devices.forEach(device => {
            const px = device.dragPixelX !== undefined
                ? device.dragPixelX
                : (room.x + device.localX) * PIXELS_PER_METER;
            const py = device.dragPixelY !== undefined
                ? device.dragPixelY
                : (room.y + device.localY) * PIXELS_PER_METER;
            drawDeviceVector(device.type, px, py, PIXELS_PER_METER);
        });
    });

    drawEntryPoint();
    drawSelectionBox();
}

function updateStatsCards() {
    const roomCount = rooms.length;
    const deviceCount = rooms.reduce((sum, room) => sum + room.devices.length, 0);
    const switchCount = localSwitches.length + (centralSwitch ? 1 : 0);

    setText('statRooms', roomCount);
    setText('statDevices', deviceCount);
    setText('statSwitches', switchCount);
    setText('statCable', `${lastCableLength} м`);
    setText('statWalls', getAllWalls().size);
    setText('statDoors', doors.size);
    setText('statPenetrations', penetrations.size);
    setText('statSuggested', suggestedPenetrations.size);
    setEntryTypeText();
}

function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
}

function pointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    return {
        mouseX: e.clientX - rect.left,
        mouseY: e.clientY - rect.top,
        pos: {
            x: Math.floor((e.clientX - rect.left) / PIXELS_PER_METER),
            y: Math.floor((e.clientY - rect.top) / PIXELS_PER_METER)
        }
    };
}

canvas.addEventListener('mousedown', e => {
    const { mouseX, mouseY, pos } = pointFromEvent(e);

    if (currentTool === 'entry') {
        placeNetworkEntry(mouseX, mouseY);
        return;
    }

    if (currentTool !== 'select') {
        editWallAt(mouseX, mouseY);
        return;
    }

    for (let i = rooms.length - 1; i >= 0; i--) {
        const room = rooms[i];
        const rx = room.x * PIXELS_PER_METER;
        const ry = room.y * PIXELS_PER_METER;
        const rw = room.w * PIXELS_PER_METER;
        const rh = room.h * PIXELS_PER_METER;

        if (mouseX >= rx + rw - 24 && mouseX <= rx + rw && mouseY >= ry && mouseY <= ry + 24) {
            openModal(room);
            return;
        }

        if (mouseX >= rx + rw - 16 && mouseX <= rx + rw && mouseY >= ry + rh - 16 && mouseY <= ry + rh) {
            actionState = 'resize';
            targetRoom = room;
            return;
        }
    }

    if (centralSwitch && pos.x === centralSwitch.x && pos.y === centralSwitch.y) {
        actionState = 'drag_switch';
        dragOffsetX = mouseX - centralSwitch.x * PIXELS_PER_METER;
        dragOffsetY = mouseY - centralSwitch.y * PIXELS_PER_METER;
        return;
    }

    for (let i = rooms.length - 1; i >= 0; i--) {
        const room = rooms[i];

        if (
            networkGenerated &&
            room.switchLocalX !== undefined &&
            pos.x === room.x + room.switchLocalX &&
            pos.y === room.y + room.switchLocalY
        ) {
            actionState = 'drag_local_switch';
            targetRoom = room;
            dragOffsetX = mouseX - (room.x + room.switchLocalX) * PIXELS_PER_METER;
            dragOffsetY = mouseY - (room.y + room.switchLocalY) * PIXELS_PER_METER;
            return;
        }

        for (const device of room.devices) {
            if (pos.x === room.x + device.localX && pos.y === room.y + device.localY) {
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
        if (pos.x >= room.x && pos.x < room.x + room.w && pos.y >= room.y && pos.y < room.y + room.h) {
            actionState = 'drag';
            targetRoom = room;

            if (e.shiftKey) {
                room.selected = !room.selected;
            } else if (!room.selected) {
                rooms.forEach(r => { r.selected = false; });
                room.selected = true;
            }

            initialMousePos = pos;
            rooms.forEach(r => {
                if (r.selected) {
                    r.origX = r.x;
                    r.origY = r.y;
                }
            });
            return;
        }
    }

    if (!e.shiftKey) rooms.forEach(room => { room.selected = false; });
    actionState = 'select';
    selectionBox = { startX: mouseX, startY: mouseY, w: 0, h: 0 };
    draw();
});

window.addEventListener('mousemove', e => {
    const { mouseX, mouseY, pos } = pointFromEvent(e);

    if (actionState === 'select') {
        selectionBox.w = mouseX - selectionBox.startX;
        selectionBox.h = mouseY - selectionBox.startY;
        draw();
        return;
    }

    if (!actionState) {
        let hover = currentTool === 'select' ? 'default' : 'crosshair';
        if (currentTool === 'select') {
            for (let i = rooms.length - 1; i >= 0; i--) {
                const room = rooms[i];
                const rx = room.x * PIXELS_PER_METER;
                const ry = room.y * PIXELS_PER_METER;
                const rw = room.w * PIXELS_PER_METER;
                const rh = room.h * PIXELS_PER_METER;
                if (mouseX >= rx + rw - 24 && mouseX <= rx + rw && mouseY >= ry && mouseY <= ry + 24) { hover = 'pointer'; break; }
                if (mouseX >= rx + rw - 16 && mouseX <= rx + rw && mouseY >= ry + rh - 16 && mouseY <= ry + rh) { hover = 'se-resize'; break; }
                if (pos.x >= room.x && pos.x < room.x + room.w && pos.y >= room.y && pos.y < room.y + room.h) { hover = 'move'; break; }
            }
            if (hover === 'default' && centralSwitch && pos.x === centralSwitch.x && pos.y === centralSwitch.y) hover = 'move';
        }
        canvas.style.cursor = hover;
        return;
    }

    canvas.style.cursor = actionState === 'resize' ? 'se-resize' : 'move';

    if (actionState === 'drag_switch' && centralSwitch) {
        centralSwitch.dragPixelX = mouseX - dragOffsetX;
        centralSwitch.dragPixelY = mouseY - dragOffsetY;
        draw();
    } else if (actionState === 'drag_device' && targetDevice) {
        targetDevice.dragPixelX = mouseX - dragOffsetX;
        targetDevice.dragPixelY = mouseY - dragOffsetY;
        draw();
    } else if (actionState === 'drag_local_switch' && targetRoom) {
        targetRoom.switchDragPixelX = mouseX - dragOffsetX;
        targetRoom.switchDragPixelY = mouseY - dragOffsetY;
        draw();
    } else if (actionState === 'drag' && initialMousePos) {
        const dxRaw = pos.x - initialMousePos.x;
        const dyRaw = pos.y - initialMousePos.y;
        const selectedRooms = rooms.filter(room => room.selected);
        if (!selectedRooms.length) return;

        const minDx = -Math.min(...selectedRooms.map(r => r.origX));
        const maxDx = cols - Math.max(...selectedRooms.map(r => r.origX + r.w));
        const minDy = -Math.min(...selectedRooms.map(r => r.origY));
        const maxDy = rows - Math.max(...selectedRooms.map(r => r.origY + r.h));
        const dx = Math.max(minDx, Math.min(maxDx, dxRaw));
        const dy = Math.max(minDy, Math.min(maxDy, dyRaw));

        selectedRooms.forEach(room => {
            room.x = room.origX + dx;
            room.y = room.origY + dy;
        });

        cleanupPassages();
        resetNetworkCables();
        draw();
    } else if (actionState === 'resize' && targetRoom) {
        targetRoom.w = clampInt(pos.x - targetRoom.x + 1, 2, cols - targetRoom.x);
        targetRoom.h = clampInt(pos.y - targetRoom.y + 1, 2, rows - targetRoom.y);

        targetRoom.devices.forEach(device => {
            device.localX = Math.min(device.localX, targetRoom.w - 1);
            device.localY = Math.min(device.localY, targetRoom.h - 1);
        });

        if (targetRoom.switchLocalX !== undefined && (targetRoom.switchLocalX >= targetRoom.w || targetRoom.switchLocalY >= targetRoom.h)) {
            delete targetRoom.switchLocalX;
            delete targetRoom.switchLocalY;
        }

        cleanupPassages();
        resetNetworkCables();
        draw();
    }
});

window.addEventListener('mouseup', () => {
    if (actionState === 'drag_device' && targetDevice && targetRoom) {
        let newLx = Math.round(targetDevice.dragPixelX / PIXELS_PER_METER) - targetRoom.x;
        let newLy = Math.round(targetDevice.dragPixelY / PIXELS_PER_METER) - targetRoom.y;
        newLx = clampInt(newLx, 0, targetRoom.w - 1);
        newLy = clampInt(newLy, 0, targetRoom.h - 1);

        const occupied = targetRoom.devices.some(d => d !== targetDevice && d.localX === newLx && d.localY === newLy)
            || (networkGenerated && targetRoom.switchLocalX === newLx && targetRoom.switchLocalY === newLy)
            || (networkEntry && networkEntry.roomId === targetRoom.id && networkEntry.x === targetRoom.x + newLx && networkEntry.y === targetRoom.y + newLy);

        if (!occupied) {
            targetDevice.localX = newLx;
            targetDevice.localY = newLy;
        }

        delete targetDevice.dragPixelX;
        delete targetDevice.dragPixelY;
        resetNetworkCables();
        draw();
    } else if (actionState === 'drag_local_switch' && targetRoom) {
        let newLx = Math.round(targetRoom.switchDragPixelX / PIXELS_PER_METER) - targetRoom.x;
        let newLy = Math.round(targetRoom.switchDragPixelY / PIXELS_PER_METER) - targetRoom.y;
        newLx = clampInt(newLx, 0, targetRoom.w - 1);
        newLy = clampInt(newLy, 0, targetRoom.h - 1);

        const occupied = targetRoom.devices.some(d => d.localX === newLx && d.localY === newLy)
            || (networkEntry && networkEntry.roomId === targetRoom.id && networkEntry.x === targetRoom.x + newLx && networkEntry.y === targetRoom.y + newLy);
        if (!occupied) {
            targetRoom.switchLocalX = newLx;
            targetRoom.switchLocalY = newLy;
        }

        delete targetRoom.switchDragPixelX;
        delete targetRoom.switchDragPixelY;
        resetNetworkCables();
        draw();
    } else if (actionState === 'drag_switch' && centralSwitch) {
        const nx = clampInt(Math.round(centralSwitch.dragPixelX / PIXELS_PER_METER), 0, cols - 1);
        const ny = clampInt(Math.round(centralSwitch.dragPixelY / PIXELS_PER_METER), 0, rows - 1);
        centralSwitch.x = nx;
        centralSwitch.y = ny;
        if (networkEntry) {
            networkEntry.x = nx;
            networkEntry.y = ny;
            const room = getRoomAtCell(nx, ny);
            networkEntry.roomId = networkEntry.type === 'server' ? room?.id ?? null : room?.id ?? null;
        }
        delete centralSwitch.dragPixelX;
        delete centralSwitch.dragPixelY;
        resetNetworkCables();
        setEntryTypeText();
        draw();
    } else if (actionState === 'select' && selectionBox) {
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

    rooms.forEach(room => {
        delete room.origX;
        delete room.origY;
    });

    actionState = null;
    targetRoom = null;
    targetDevice = null;
    initialMousePos = null;
    canvas.style.cursor = currentTool === 'select' ? 'default' : 'crosshair';
});

function collectProject() {
    return {
        version: PROJECT_VERSION,
        app: 'Network Planner',
        grid: {
            pixelsPerMeter: PIXELS_PER_METER,
            width: canvas.width,
            height: canvas.height
        },
        rooms: structuredClone(rooms),
        networkEntry: structuredClone(networkEntry),
        centralSwitch: structuredClone(centralSwitch),
        manualWalls: [...manualWalls],
        doors: [...doors],
        penetrations: [...penetrations],
        suggestedPenetrations: [...suggestedPenetrations],
        networkGenerated
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
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function loadProjectFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
        try {
            const data = sanitizeProject(JSON.parse(reader.result));
            rooms = structuredClone(data.rooms);
            rooms.forEach(room => {
                room.selected = false;
                delete room.origX;
                delete room.origY;
                delete room.dragPixelX;
                delete room.dragPixelY;
                delete room.switchDragPixelX;
                delete room.switchDragPixelY;
            });

            networkEntry = structuredClone(data.networkEntry ?? null);

            // Совместимость с v0.4: если точки входа нет, используем старый CORE как источник.
            centralSwitch = structuredClone(data.centralSwitch ?? null);
            if (!networkEntry && centralSwitch) {
                networkEntry = {
                    type: centralSwitch.type === 'router' ? 'provider' : 'server',
                    x: centralSwitch.x,
                    y: centralSwitch.y,
                    roomId: getRoomAtCell(centralSwitch.x, centralSwitch.y)?.id ?? null
                };
            }

            manualWalls = new Set(Array.isArray(data.manualWalls) ? data.manualWalls : []);
            doors = new Set(Array.isArray(data.doors) ? data.doors : []);
            penetrations = new Set(Array.isArray(data.penetrations) ? data.penetrations : []);
            suggestedPenetrations = new Set(Array.isArray(data.suggestedPenetrations) ? data.suggestedPenetrations : []);
            cleanupPassages();

            cables = [];
            localSwitches = [];
            networkGenerated = false;
            unreachableConnections = 0;
            lastCableLength = 0;

            if (networkEntry) {
                const entryTypeSelect = document.getElementById('entryType');
                if (entryTypeSelect) entryTypeSelect.value = networkEntry.type === 'provider' ? 'provider' : 'server';
                ensureEntry();
            }

            if (data.networkGenerated && networkEntry) generateNetwork();
            else {
                updateStatsCards();
                draw();
            }
        } catch (error) {
            alert(`Не удалось загрузить проект: ${error.message}`);
        } finally {
            event.target.value = '';
        }
    };
    reader.readAsText(file, 'utf-8');
}

window.setTool = setTool;
window.addRoom = addRoom;
window.addRoomFromToolbar = addRoomFromToolbar;
window.generateNetwork = generateNetwork;
window.clearAll = initGrid;
window.openModal = openModal;
window.closeModal = closeModal;
window.saveModal = saveModal;
window.saveProject = saveProject;
window.loadProjectFile = loadProjectFile;
window.acceptSuggestedPenetrations = acceptSuggestedPenetrations;
window.clearSuggestedPenetrations = clearSuggestedPenetrations;
window.clearNetworkEntry = clearNetworkEntry;

const entryTypeSelect = document.getElementById('entryType');
if (entryTypeSelect) {
    entryTypeSelect.addEventListener('change', () => {
        setEntryTypeText();
        if (networkEntry) {
            networkEntry = null;
            centralSwitch = null;
            invalidateNetwork();
        }
    });
}

setTool('select');
setEntryTypeText();
updateStatsCards();
draw();

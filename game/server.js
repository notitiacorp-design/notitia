#!/usr/bin/env node
// Conquest — WebSocket game server for Notitia
const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const TERRITORY_COUNT = 24;
const ADJ = [
  [1,3],[0,2,3,4],[1,5],[0,1,4,7],[1,3,5,8],[2,4,6,9],[5,10,11],[3,8],[4,7,9,12],[5,8,10,13],
  [6,9,11,14],[6,10,15],[8,13,16],[9,12,14,17],[10,13,15,18],[11,14,19],[12,17],[13,16,18,21],
  [14,17,19,22],[15,18,20,23],[19,23],[17,22],[18,21,23],[19,20,22]
];

// Game rooms
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for(let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createGameState(playerCount) {
  // Distribute territories randomly
  const territories = [...Array(TERRITORY_COUNT).keys()];
  // Shuffle
  for(let i = territories.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [territories[i], territories[j]] = [territories[j], territories[i]];
  }
  
  const owners = new Array(TERRITORY_COUNT).fill(-1);
  const troops = new Array(TERRITORY_COUNT).fill(0);
  const tPerPlayer = Math.floor(TERRITORY_COUNT / playerCount);
  
  for(let p = 0; p < playerCount; p++) {
    for(let i = 0; i < tPerPlayer; i++) {
      const idx = p * tPerPlayer + i;
      owners[territories[idx]] = p;
      troops[territories[idx]] = 3;
    }
  }
  // Remaining
  for(let i = playerCount * tPerPlayer; i < TERRITORY_COUNT; i++) {
    owners[territories[i]] = (i - playerCount * tPerPlayer) % playerCount;
    troops[territories[i]] = 3;
  }
  
  return {
    owners, troops,
    currentPlayer: 0,
    phase: 'reinforce',
    availableTroops: Math.max(3, tPerPlayer),
    playerCount,
    players: [],
    winner: undefined,
    territoryCount: {}
  };
}

function getTerritoryCounts(state) {
  const counts = {};
  state.owners.forEach(o => {
    if(o >= 0) counts[o] = (counts[o] || 0) + 1;
  });
  state.territoryCount = counts;
}

function checkWinner(state) {
  const alive = new Set(state.owners.filter(o => o >= 0));
  if(alive.size <= 1) {
    state.winner = alive.values().next().value;
    return true;
  }
  return false;
}

function rollDice(count) {
  const dice = [];
  for(let i = 0; i < count; i++) dice.push(Math.floor(Math.random() * 6) + 1);
  return dice.sort((a,b) => b - a);
}

function resolveCombat(from, to, state) {
  const atkTroops = state.troops[from] - 1; // must leave 1
  const defTroops = state.troops[to];
  const atkDice = rollDice(Math.min(3, atkTroops));
  const defDice = rollDice(Math.min(2, defTroops));
  
  let atkLoss = 0, defLoss = 0;
  const rounds = Math.min(atkDice.length, defDice.length);
  for(let i = 0; i < rounds; i++) {
    if(atkDice[i] > defDice[i]) defLoss++;
    else atkLoss++;
  }
  
  state.troops[from] -= atkLoss;
  state.troops[to] -= defLoss;
  
  if(state.troops[to] <= 0) {
    // Conquered!
    const move = Math.min(atkDice.length, atkTroops);
    state.owners[to] = state.owners[from];
    state.troops[to] = move;
    state.troops[from] -= move;
  }
  
  return { atkDice, defDice, atkLoss, defLoss };
}

// HTTP server for static files
const server = http.createServer((req, res) => {
  // Serve from the notitia-site root directory
  const rootDir = path.join(__dirname, '..');
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // Handle directory URLs
  if(filePath.endsWith('/')) filePath += 'index.html';
  filePath = path.join(rootDir, filePath);
  
  const ext = path.extname(filePath);
  const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css'}[ext] || 'text/plain';
  
  fs.readFile(filePath, (err, data) => {
    if(err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, {'Content-Type': mime});
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let playerRoom = null;
  let playerIdx = null;
  
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    
    switch(msg.type) {
      case 'create_room': {
        const code = generateRoomCode();
        const state = createGameState(msg.playerCount || 2);
        playerIdx = 0;
        state.players.push({id: 0, name: 'Joueur 1', color: 0, ws});
        
        rooms[code] = { state, clients: [ws], nextId: 1 };
        playerRoom = code;
        
        ws.send(JSON.stringify({type:'room_created', roomCode:code, playerId:0}));
        ws.send(JSON.stringify({type:'player_list', players: state.players.map(p => ({id:p.id, name:p.name, color:p.color}))}));
        break;
      }
      
      case 'join_room': {
        const room = rooms[msg.roomCode];
        if(!room) { ws.send(JSON.stringify({type:'error', message:'Room introuvable.'})); break; }
        if(room.state.players.length >= room.state.playerCount) {
          ws.send(JSON.stringify({type:'error', message:'Room pleine.'})); break;
        }
        
        const pid = room.nextId++;
        const pcolor = room.state.players.length;
        room.state.players.push({id: pid, name: `Joueur ${pcolor+1}`, color: pcolor, ws});
        room.clients.push(ws);
        playerRoom = msg.roomCode;
        playerIdx = pid;
        
        ws.send(JSON.stringify({type:'joined', roomCode:msg.roomCode, playerId:pid}));
        
        // Broadcast player list
        const pList = room.state.players.map(p => ({id:p.id, name:p.name, color:p.color}));
        room.clients.forEach(c => c.send(JSON.stringify({type:'player_list', players: pList})));
        
        // Start if enough players
        if(room.state.players.length >= room.state.playerCount) {
          getTerritoryCounts(room.state);
          room.clients.forEach((c, i) => {
            c.send(JSON.stringify({
              type:'game_start', state:room.state, playerId: room.state.players[i].id
            }));
          });
        }
        break;
      }
      
      case 'reinforce': {
        const room = rooms[playerRoom];
        if(!room || room.state.currentPlayer !== playerIdx) break;
        if(room.state.owners[msg.territory] !== playerIdx || room.state.availableTroops <= 0) break;
        
        room.state.troops[msg.territory]++;
        room.state.availableTroops--;
        
        broadcast(room);
        break;
      }
      
      case 'reinforce_done': {
        const room = rooms[playerRoom];
        if(!room || room.state.currentPlayer !== playerIdx || room.state.phase !== 'reinforce') break;
        
        room.state.phase = 'attack';
        broadcast(room);
        break;
      }
      
      case 'attack': {
        const room = rooms[playerRoom];
        if(!room || room.state.currentPlayer !== playerIdx || room.state.phase !== 'attack') break;
        
        const {from, to} = msg;
        if(room.state.owners[from] !== playerIdx) break;
        if(room.state.owners[to] === playerIdx) break;
        if(room.state.troops[from] < 2) break;
        if(!ADJ[from].includes(to)) break;
        
        const result = resolveCombat(from, to, room.state);
        
        broadcast(room);
        
        // Send combat result to all
        room.clients.forEach(c => c.send(JSON.stringify({
          type:'combat_result', attacker:from, defender:to,
          aDice:result.atkDice, dDice:result.defDice,
          aLoss:result.atkLoss, dLoss:result.defLoss
        })));
        
        getTerritoryCounts(room.state);
        if(checkWinner(room.state)) {
          room.clients.forEach(c => c.send(JSON.stringify({
            type:'game_over', state:room.state, winner:room.state.winner
          })));
        }
        break;
      }
      
      case 'attack_done': {
        const room = rooms[playerRoom];
        if(!room || room.state.currentPlayer !== playerIdx || room.state.phase !== 'attack') break;
        
        room.state.phase = 'fortify';
        broadcast(room);
        break;
      }
      
      case 'fortify': {
        const room = rooms[playerRoom];
        if(!room || room.state.currentPlayer !== playerIdx || room.state.phase !== 'fortify') break;
        
        const {from, to, count} = msg;
        if(room.state.owners[from] !== playerIdx || room.state.owners[to] !== playerIdx) break;
        if(!ADJ[from].includes(to)) break;
        if(room.state.troops[from] <= count || count < 1) break;
        
        room.state.troops[from] -= count;
        room.state.troops[to] += count;
        
        broadcast(room);
        break;
      }
      
      case 'fortify_done': {
        const room = rooms[playerRoom];
        if(!room || room.state.currentPlayer !== playerIdx || room.state.phase !== 'fortify') break;
        
        // Next player
        room.state.currentPlayer = (room.state.currentPlayer + 1) % room.state.playerCount;
        const newPlayer = room.state.currentPlayer;
        room.state.phase = 'reinforce';
        room.state.availableTroops = Math.max(3, room.state.territoryCount[newPlayer] || 0);
        
        broadcast(room);
        break;
      }
    }
  });
  
  ws.on('close', () => {
    if(playerRoom && rooms[playerRoom]) {
      rooms[playerRoom].clients = rooms[playerRoom].clients.filter(c => c !== ws);
      if(rooms[playerRoom].clients.length === 0) {
        delete rooms[playerRoom];
      }
    }
  });
});

function broadcast(room) {
  room.clients.forEach((c, i) => {
    c.send(JSON.stringify({type:'state_update', state: room.state}));
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Conquest server running on port ${PORT}`);
  console.log(`Game: http://localhost:${PORT}/game/`);
  console.log(`Site: http://localhost:${PORT}/`);
});

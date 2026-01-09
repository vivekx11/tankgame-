// ============================================================================
// Advanced Tank Battle Arena - Multiplayer Game Server
// ============================================================================
// Description: Real-time multiplayer tank battle game using Node.js & Socket.io
// Technologies: Express.js, Socket.io, Canvas Physics Engine
// Features: Player movement, shooting, collision detection, health system,
//          real-time updates, respawn mechanics
// Author: Team Suno Shizume
// License: ISC
// Last Updated: 2024
// ============================================================================

// ============================================================================
// IMPORTS - Required modules for the game server
// ============================================================================

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

// Game Constants
// ============================================================================
// GAME CONFIGURATION - All game balance and physics settings
// ============================================================================
// Arena Dimensions: Define the playing field size
// Tank Properties: Size, speed, rotation, health
// Bullet Properties: Speed, damage, lifetime, collision radius
// Game Balance: Health values, respawn times, repair mechanics, cooldowns
// Physics: Friction for realistic movement, rotation speed for tank turning
// ============================================================================

const GAME_CONFIG = {
  ARENA_WIDTH: 1200,
  ARENA_HEIGHT: 700,
  TANK_WIDTH: 30,
  TANK_HEIGHT: 20,
  TANK_RADIUS: 15,
  BULLET_RADIUS: 10,
  BULLET_SPEED: 35,
  BULLET_DAMAGE: 25,
  MAX_HEALTH: 100,
  TANK_SPEED: 30,
  TANK_BOOST_MULTIPLIER: 1.8,
  FRICTION: 0.92,
  ROTATION_SPEED: 0.1,
  RESPAWN_TIME: 3000, // ms
  BULLET_LIFETIME: 2000, // ms
  REPAIR_AMOUNT: 10,
  REPAIR_COOLDOWN: 5000 // ms
};

const players = {};
const bullets = [];
const lastRepairTime = {};

// ============================================================================
// PLAYER CLASS - Represents a single player tank in the game arena
// ============================================================================
// Properties:
//   Position & Movement: x, y coordinates, velocity (vx, vy), speed control
//   Rotation: angle (current rotation), targetAngle (desired rotation)
//   Health System: hp (current health), maxHP, isAlive status
//   Shooting: lastShot (timestamp), shootCooldown (rate limiting)
//   Respawn: respawnTime (countdown timer)
//   Scoring: score tracking for game statistics
//   Repair System: lastRepairTime tracking to prevent abuse
// Methods:
//   move() - Apply physics, friction, and movement to tank
//   shoot() - Create bullet when conditions are met
//   takeDamage() - Reduce health on bullet impact
//   repair() - Heal tank with cooldown protection
//   toJSON() - Serialize for network transmission
// ============================================================================

// Physics-based Player class
class Player {
  constructor(id, x, y) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.angle = 0;
    this.targetAngle = 0;
    this.hp = GAME_CONFIG.MAX_HEALTH;
    this.score = 0;
    this.name = `Player_${id.slice(0, 4)}`;
    this.isAlive = true;
    this.respawnTime = 0;
    this.lastShot = 0;
    this.shootCooldown = 300; // ms
  }

  update(deltaTime) {
    // Handle respawn
    if (!this.isAlive) {
      if (Date.now() > this.respawnTime) {
        this.respawn();
      }
      return;
    }

    // Apply friction
    this.vx *= GAME_CONFIG.FRICTION;
    this.vy *= GAME_CONFIG.FRICTION;

    // Update position
    this.x += this.vx * deltaTime;
    this.y += this.vy * deltaTime;

    // Smooth rotation
    let angleDiff = this.targetAngle - this.angle;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    
    this.angle += angleDiff * 0.2;

    // Boundary collision
    this.x = Math.max(GAME_CONFIG.TANK_RADIUS, 
                     Math.min(GAME_CONFIG.ARENA_WIDTH - GAME_CONFIG.TANK_RADIUS, this.x));
    this.y = Math.max(GAME_CONFIG.TANK_RADIUS, 
                     Math.min(GAME_CONFIG.ARENA_HEIGHT - GAME_CONFIG.TANK_RADIUS, this.y));
  }

  applyInput(input) {
    if (!this.isAlive) return;

    const speed = GAME_CONFIG.TANK_SPEED * (input.boost || 1);
    
    // Set velocity based on input
    if (input.dx !== 0 || input.dy !== 0) {
      this.vx = input.dx * speed;
      this.vy = input.dy * speed;
      this.targetAngle = Math.atan2(this.vy, this.vx);
    }
  }

  shoot() {
    if (!this.isAlive) return null;
    
    const now = Date.now();
    if (now - this.lastShot < this.shootCooldown) return null;
    
    this.lastShot = now;
    
    // Calculate bullet spawn position (from cannon tip)
    const cannonLength = 25;
    const bulletX = this.x + Math.cos(this.angle) * cannonLength;
    const bulletY = this.y + Math.sin(this.angle) * cannonLength;
    
    return {
      x: bulletX,
      y: bulletY,
      vx: Math.cos(this.angle) * GAME_CONFIG.BULLET_SPEED,
      vy: Math.sin(this.angle) * GAME_CONFIG.BULLET_SPEED,
      owner: this.id,
      createdAt: Date.now(),
      angle: this.angle
    };
  }

  takeDamage(damage, attackerId) {
    if (!this.isAlive) return false;
    
    this.hp -= damage;
    
    if (this.hp <= 0) {
      this.die();
      if (players[attackerId]) {
        players[attackerId].score += 100;
        io.to(attackerId).emit("kill", { victim: this.name });
      }
      return true;
    }
    return false;
  }

  die() {
    this.isAlive = false;
    this.hp = 0;
    this.respawnTime = Date.now() + GAME_CONFIG.RESPAWN_TIME;
    this.vx = 0;
    this.vy = 0;
    
    // Emit death to player
    io.to(this.id).emit("died");
  }

  respawn() {
    this.isAlive = true;
    this.hp = GAME_CONFIG.MAX_HEALTH;
    this.x = Math.random() * (GAME_CONFIG.ARENA_WIDTH - 200) + 100;
    this.y = Math.random() * (GAME_CONFIG.ARENA_HEIGHT - 200) + 100;
    this.vx = 0;
    this.vy = 0;
    this.angle = 0;
    this.targetAngle = 0;
    
    io.to(this.id).emit("respawned");
  }

  repair() {
    if (!this.isAlive) return false;
    
    const now = Date.now();
    if (lastRepairTime[this.id] && now - lastRepairTime[this.id] < GAME_CONFIG.REPAIR_COOLDOWN) {
      return false;
    }
    
    lastRepairTime[this.id] = now;
    this.hp = Math.min(GAME_CONFIG.MAX_HEALTH, this.hp + GAME_CONFIG.REPAIR_AMOUNT);
    return true;
  }

  toJSON() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      angle: this.angle,
      hp: this.hp,
      score: this.score,
      name: this.name,
      isAlive: this.isAlive,
      vx: this.vx,
      vy: this.vy
    };
  }
}

// Bullet class
class Bullet {
  constructor(data) {
    Object.assign(this, data);
    this.createdAt = Date.now();
  }

  update(deltaTime) {
    this.x += this.vx * deltaTime;
    this.y += this.vy * deltaTime;
    
    // Remove if out of bounds or too old
    if (this.x < -50 || this.x > GAME_CONFIG.ARENA_WIDTH + 50 ||
        this.y < -50 || this.y > GAME_CONFIG.ARENA_HEIGHT + 50 ||
        Date.now() - this.createdAt > GAME_CONFIG.BULLET_LIFETIME) {
      return false;
    }
    return true;
  }

  toJSON() {
    return {
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      angle: Math.atan2(this.vy, this.vx),
      owner: this.owner
    };
  }
}

io.on("connection", (socket) => {
  console.log("Player joined:", socket.id);

  // Create new player in safe spawn location
  const spawnX = Math.random() * (GAME_CONFIG.ARENA_WIDTH - 200) + 100;
  const spawnY = Math.random() * (GAME_CONFIG.ARENA_HEIGHT - 200) + 100;
  
  players[socket.id] = new Player(socket.id, spawnX, spawnY);

  // Send initial state to new player
  socket.emit("init", {
    myPlayerId: socket.id,
    config: GAME_CONFIG
  });

  // Movement input
  socket.on("move", (data) => {
    const player = players[socket.id];
    if (player) {
      player.applyInput(data);
    }
  });

  // Shooting
  socket.on("shoot", (data) => {
    const player = players[socket.id];
    if (player) {
      const bulletData = player.shoot();
      if (bulletData) {
        const bullet = new Bullet(bulletData);
        bullets.push(bullet);
        
        // Play shoot sound to nearby players
        socket.broadcast.emit("shootSound", {
          x: bullet.x,
          y: bullet.y
        });
      }
    }
  });

  // Repair
  socket.on("repair", () => {
    const player = players[socket.id];
    if (player && player.repair()) {
      socket.emit("repaired", { hp: player.hp });
    }
  });

  // Disconnection
  socket.on("disconnect", () => {
    console.log("Player left:", socket.id);
    delete players[socket.id];
    delete lastRepairTime[socket.id];
  });
});

// Game loop
const FPS = 120;
const frameTime = 1000 / FPS;
let lastUpdate = Date.now();

function gameLoop() {
  const now = Date.now();
  const deltaTime = (now - lastUpdate) / 1000; // Convert to seconds
  lastUpdate = now;

  // Update all players
  Object.values(players).forEach(player => {
    player.update(deltaTime);
  });

  // Update bullets and check collisions
  for (let i = bullets.length - 1; i >= 0; i--) {
    const bullet = bullets[i];
    
    // Update bullet position
    if (!bullet.update(deltaTime)) {
      bullets.splice(i, 1);
      continue;
    }

    // Check collision with players
    for (const playerId in players) {
      const player = players[playerId];
      
      if (player.isAlive && player.id !== bullet.owner) {
        const dx = bullet.x - player.x;
        const dy = bullet.y - player.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < GAME_CONFIG.TANK_RADIUS + GAME_CONFIG.BULLET_RADIUS) {
          // Hit detected!
          const died = player.takeDamage(GAME_CONFIG.BULLET_DAMAGE, bullet.owner);
          
          // Remove bullet
          bullets.splice(i, 1);
          
          // Emit hit effect to both players
          io.to(playerId).emit("hit", {
            damage: GAME_CONFIG.BULLET_DAMAGE,
            attacker: bullet.owner
          });
          
          if (died) {
            io.emit("playerDied", {
              playerId: playerId,
              killerId: bullet.owner
            });
          }
          break;
        }
      }
    }
  }

  // Check tank-to-tank collisions
  const playerArray = Object.values(players);
  for (let i = 0; i < playerArray.length; i++) {
    for (let j = i + 1; j < playerArray.length; j++) {
      const p1 = playerArray[i];
      const p2 = playerArray[j];
      
      if (p1.isAlive && p2.isAlive) {
        const dx = p1.x - p2.x;
        const dy = p1.y - p2.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const minDistance = GAME_CONFIG.TANK_RADIUS * 2;
        
        if (distance < minDistance) {
          // Elastic collision response
          const angle = Math.atan2(dy, dx);
          const targetX = p1.x + Math.cos(angle) * minDistance;
          const targetY = p1.y + Math.sin(angle) * minDistance;
          
          const ax = (targetX - p2.x) * 0.1;
          const ay = (targetY - p2.y) * 0.1;
          
          p1.vx -= ax;
          p1.vy -= ay;
          p2.vx += ax;
          p2.vy += ay;
          
          // Push tanks apart
          const overlap = (minDistance - distance) / 2;
          p1.x += Math.cos(angle) * overlap;
          p1.y += Math.sin(angle) * overlap;
          p2.x -= Math.cos(angle) * overlap;
          p2.y -= Math.sin(angle) * overlap;
        }
      }
    }
  }

  // Broadcast game state to all players
  io.emit("state", {
    players: Object.fromEntries(
      Object.entries(players).map(([id, player]) => [id, player.toJSON()])
    ),
    bullets: bullets.map(bullet => bullet.toJSON()),
    timestamp: Date.now()
  });

  // Clean up old bullets
  const nowTime = Date.now();
  for (let i = bullets.length - 1; i >= 0; i--) {
    if (nowTime - bullets[i].createdAt > GAME_CONFIG.BULLET_LIFETIME) {
      bullets.splice(i, 1);
    }
  }
}

// Start game loop
setInterval(gameLoop, frameTime);

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Arena size: ${GAME_CONFIG.ARENA_WIDTH}x${GAME_CONFIG.ARENA_HEIGHT}`);
});

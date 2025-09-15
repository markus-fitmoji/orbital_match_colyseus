import { createServer } from 'http';
import { Server } from 'socket.io';
import express from 'express';
import Matter from 'matter-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { pgTable, serial, varchar, json, timestamp } from 'drizzle-orm/pg-core';

// Database schema
const gameRooms = pgTable('game_rooms', {
  id: serial('id').primaryKey(),
  roomName: varchar('room_name', { length: 100 }).notNull().unique(),
  gameState: json('game_state').notNull(),
  lastActivity: timestamp('last_activity').notNull().defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Database connection (optional)
const connectionString = process.env.DATABASE_URL || '';
let db: any = null;

if (connectionString) {
  try {
    const client = postgres(connectionString);
    db = drizzle(client);
    console.log('Database connected successfully');
  } catch (error) {
    console.warn('Database connection failed, running without persistence:', error);
  }
} else {
  console.warn('No DATABASE_URL provided, running without persistence');
}

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*", // Adjust for production
    methods: ["GET", "POST"]
  }
});

type ColorName = 'blue' | 'green' | 'orange';

interface RoomState {
  engine: Matter.Engine;
  roomName: string;
  interval: NodeJS.Timeout;
  score: number;
  nextBallColor: ColorName;
  ballIdCounter: number;
  players: Map<string, { id: string; name: string; connected: boolean }>;
}

interface GameBall {
  id: number;
  x: number;
  y: number;
  color: ColorName;
}

interface GameStateUpdate {
  balls: GameBall[];
  score: number;
  nextBallColor: ColorName;
  players: Array<{ id: string; name: string; connected: boolean }>;
}

const rooms = new Map<string, RoomState>();
const { Engine, World, Bodies, Events, Sleeping, Body } = Matter;

const colorNames: ColorName[] = ['blue', 'green', 'orange'];
const getRandomColor = (): ColorName => colorNames[Math.floor(Math.random() * colorNames.length)];

const BALL_RADIUS = 20;
const BALL_DIAMETER = BALL_RADIUS * 2;

// Persistence functions
interface SerializableGameState {
  balls: Array<{
    id: number;
    x: number;
    y: number;
    color: ColorName;
    velocityX: number;
    velocityY: number;
    angle: number;
    angularVelocity: number;
  }>;
  score: number;
  nextBallColor: ColorName;
  ballIdCounter: number;
}

const saveRoomState = async (roomName: string, roomState: RoomState) => {
  if (!db) {
    console.log(`Skipping save for room ${roomName} (no database)`);
    return;
  }

  try {
    const gameState: SerializableGameState = {
      balls: roomState.engine.world.bodies
        .filter(body => body.label.startsWith('ball-'))
        .map(body => ({
          id: parseInt(body.label.split('-')[2]),
          x: body.position.x,
          y: body.position.y,
          color: body.label.split('-')[1] as ColorName,
          velocityX: body.velocity.x,
          velocityY: body.velocity.y,
          angle: body.angle,
          angularVelocity: body.angularVelocity,
        })),
      score: roomState.score,
      nextBallColor: roomState.nextBallColor,
      ballIdCounter: roomState.ballIdCounter,
    };

    await db
      .insert(gameRooms)
      .values({
        roomName,
        gameState: gameState as any,
        lastActivity: new Date(),
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: gameRooms.roomName,
        set: {
          gameState: gameState as any,
          lastActivity: new Date(),
          updatedAt: new Date(),
        },
      });

    console.log(`Saved state for room: ${roomName}`);
  } catch (error) {
    console.error(`Failed to save room state for ${roomName}:`, error);
  }
};

const loadRoomState = async (roomName: string): Promise<SerializableGameState | null> => {
  if (!db) {
    console.log(`Skipping load for room ${roomName} (no database)`);
    return null;
  }

  try {
    const result = await db
      .select()
      .from(gameRooms)
      .where(eq(gameRooms.roomName, roomName))
      .limit(1);

    if (result.length > 0) {
      console.log(`Loaded state for room: ${roomName}`);
      return result[0].gameState as SerializableGameState;
    }
  } catch (error) {
    console.error(`Failed to load room state for ${roomName}:`, error);
  }
  
  return null;
};

const gameLoop = (roomState: RoomState) => {
  const { engine, roomName } = roomState;
  Engine.update(engine, 1000 / 60);

  const balls: GameBall[] = engine.world.bodies
    .filter(body => body.label.startsWith('ball-'))
    .map(body => ({
      id: parseInt(body.label.split('-')[2]),
      x: body.position.x,
      y: body.position.y,
      color: body.label.split('-')[1] as ColorName,
    }));
  
  const gameState: GameStateUpdate = {
    balls,
    score: roomState.score,
    nextBallColor: roomState.nextBallColor,
    players: Array.from(roomState.players.values()),
  };
  
  io.to(roomName).emit('gameStateUpdate', gameState);
};

const checkForMatches = (roomState: RoomState) => {
  const { engine } = roomState;
  const balls = engine.world.bodies.filter(b => b.label.startsWith('ball-'));
  const visited: Set<Matter.Body> = new Set();
  const POP_DISTANCE = BALL_DIAMETER + 2;

  const getNeighbors = (seed: Matter.Body, color: string, group: Matter.Body[]) => {
    for (const other of balls) {
      if (visited.has(other) || other === seed || !other.label.includes(`-${color}-`)) continue;
      const dist = Math.hypot(other.position.x - seed.position.x, other.position.y - seed.position.y);
      if (dist <= POP_DISTANCE) {
        visited.add(other);
        group.push(other);
        getNeighbors(other, color, group);
      }
    }
  };

  const groupsToRemove: Matter.Body[][] = [];
  for (const ball of balls) {
    if (visited.has(ball)) continue;
    visited.add(ball);
    const group: Matter.Body[] = [ball];
    const color = ball.label.split('-')[1];
    getNeighbors(ball, color, group);
    if (group.length >= 3) {
      groupsToRemove.push(group);
    }
  }

  if (groupsToRemove.length > 0) {
    const allBallsToRemove = groupsToRemove.flat();
    const ballsToRemoveSet = new Set(allBallsToRemove);

    for (const ball of balls) {
      if (ballsToRemoveSet.has(ball)) continue;
      for (const removedBall of allBallsToRemove) {
        const isAbove = ball.position.y < removedBall.position.y;
        const dist = Math.hypot(ball.position.x - removedBall.position.x, ball.position.y - removedBall.position.y);
        if (isAbove && dist < BALL_DIAMETER * 1.5) {
          Sleeping.set(ball, false);
          break;
        }
      }
    }

    let totalPopped = 0;
    for (const group of groupsToRemove) {
      World.remove(engine.world, group);
      totalPopped += group.length;
    }

    if (totalPopped > 0) {
      roomState.score += totalPopped * 10;
      console.log(`Room ${roomState.roomName}: Popped ${totalPopped} balls, score now ${roomState.score}`);
      
      // Broadcast match event to all clients
      io.to(roomState.roomName).emit('ballsPopped', { count: totalPopped, newScore: roomState.score });
    }
  }
};

const createRoom = async (roomName: string): Promise<RoomState> => {
  const engine = Engine.create();
  engine.world.gravity.y = 1;
  engine.enableSleeping = true;

  const width = 400;
  const height = 700;
  const wallThickness = 40;
  
  const walls = [
    Bodies.rectangle(width / 2, -wallThickness / 2, width, wallThickness, { isStatic: true }),
    Bodies.rectangle(width / 2, height + wallThickness / 2 - 30, width, wallThickness, { isStatic: true }),
    Bodies.rectangle(-wallThickness / 2, height / 2, wallThickness, height, { isStatic: true }),
    Bodies.rectangle(width + wallThickness / 2, height / 2, wallThickness, height, { isStatic: true }),
  ];
  World.add(engine.world, walls);

  const savedState = await loadRoomState(roomName);
  
  const roomState: RoomState = { 
    engine, 
    roomName,
    score: savedState?.score || 0,
    nextBallColor: savedState?.nextBallColor || getRandomColor(),
    ballIdCounter: savedState?.ballIdCounter || 0,
    players: new Map(),
    interval: setInterval(() => gameLoop(roomState), 1000/60)
  };

  if (savedState?.balls) {
    for (const ballData of savedState.balls) {
      const ball = Bodies.circle(ballData.x, ballData.y, BALL_RADIUS, {
        label: `ball-${ballData.color}-${ballData.id}`,
        restitution: 0.5,
        friction: 0.02,
        frictionAir: 0.001,
      });
      
      Body.setVelocity(ball, { x: ballData.velocityX, y: ballData.velocityY });
      Body.setAngle(ball, ballData.angle);
      Body.setAngularVelocity(ball, ballData.angularVelocity);
      
      World.add(engine.world, ball);
    }
    console.log(`Restored ${savedState.balls.length} balls for room ${roomName}`);
  }

  let settleFrames = 0;
  const REQUIRED_SETTLE_FRAMES = 8;
  const SPEED_EPS = 0.15;
  
  Events.on(engine, 'afterUpdate', () => {
    const balls = engine.world.bodies.filter(b => b.label.startsWith('ball-'));
    if (balls.length === 0) return;
    
    const allStill = balls.every(b => b.isSleeping || Math.hypot(b.velocity.x, b.velocity.y) < SPEED_EPS);
    if (allStill) {
      settleFrames++;
      if (settleFrames >= REQUIRED_SETTLE_FRAMES) {
        settleFrames = 0;
        checkForMatches(roomState);
        saveRoomState(roomName, roomState);
      }
    } else {
      settleFrames = 0;
    }
  });

  return roomState;
};

// Health check endpoints
app.get("/", (req, res) => {
  res.send("Orbital Match Socket.IO Server is running!");
});

app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    rooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('joinRoom', async ({ roomName, name, userId }: { roomName: string, name?: string, userId?: string }) => {
    socket.join(roomName);
    console.log(`User ${socket.id} joined room: ${roomName}`);

    if (!rooms.has(roomName)) {
      const roomState = await createRoom(roomName);
      rooms.set(roomName, roomState);
      console.log(`Created new room: ${roomName}`);
    }

    const roomState = rooms.get(roomName)!;
    
    // Add player to room
    roomState.players.set(socket.id, {
      id: userId || socket.id,
      name: name || `Player ${socket.id.slice(0, 6)}`,
      connected: true
    });

    // Send initial state to joining user
    const balls: GameBall[] = roomState.engine.world.bodies
      .filter(body => body.label.startsWith('ball-'))
      .map(body => ({
        id: parseInt(body.label.split('-')[2]),
        x: body.position.x,
        y: body.position.y,
        color: body.label.split('-')[1] as ColorName,
      }));
    
    const gameState: GameStateUpdate = {
      balls,
      score: roomState.score,
      nextBallColor: roomState.nextBallColor,
      players: Array.from(roomState.players.values()),
    };
    
    socket.emit('gameStateUpdate', gameState);
  });

  socket.on('dropBall', ({ roomName, x, color }: { roomName: string, x: number, color: ColorName }) => {
    const roomState = rooms.get(roomName);
    if (!roomState) {
      console.log(`Room ${roomName} not found`);
      return;
    }

    const { engine } = roomState;
    const ballId = ++roomState.ballIdCounter;
    const ball = Bodies.circle(x, 50, BALL_RADIUS, { 
      label: `ball-${color}-${ballId}`,
      restitution: 0.5,
      friction: 0.02,
      frictionAir: 0.001,
    });
    
    World.add(engine.world, ball);
    roomState.nextBallColor = getRandomColor();
    
    console.log(`Ball dropped in room ${roomName} at x=${x}, color=${color}, id=${ballId}`);
    saveRoomState(roomName, roomState);
  });

  socket.on('resetGame', ({ roomName }: { roomName: string }) => {
    const roomState = rooms.get(roomName);
    if (!roomState) {
      console.log(`Room ${roomName} not found for reset`);
      return;
    }

    const balls = roomState.engine.world.bodies.filter(b => b.label.startsWith('ball-'));
    World.remove(roomState.engine.world, balls);
    
    roomState.score = 0;
    roomState.nextBallColor = getRandomColor();
    roomState.ballIdCounter = 0;
    
    console.log(`Game reset in room ${roomName}`);
    io.to(roomName).emit('gameReset');
    saveRoomState(roomName, roomState);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    // Mark player as disconnected in all rooms
    for (const [roomName, roomState] of rooms.entries()) {
      const player = roomState.players.get(socket.id);
      if (player) {
        player.connected = false;
        
        // Remove player after 30 seconds if they don't reconnect
        setTimeout(() => {
          if (!player.connected) {
            roomState.players.delete(socket.id);
            console.log(`Removed disconnected player ${socket.id} from room ${roomName}`);
          }
        }, 30000);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Socket.IO server running on port ${PORT}`);
});

process.on('SIGINT', () => {
  console.log('Shutting down server...');
  
  for (const [roomName, roomState] of rooms.entries()) {
    clearInterval(roomState.interval);
    console.log(`Cleaned up room: ${roomName}`);
  }
  
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
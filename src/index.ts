import { createServer } from 'http';
import { Server } from 'socket.io';
import express from 'express';
import Matter from 'matter-js';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and } from 'drizzle-orm';
import { pgTable, serial, varchar, json, timestamp, integer, boolean } from 'drizzle-orm/pg-core';

// Database schema
const gameRooms = pgTable('game_rooms', {
  id: serial('id').primaryKey(),
  roomName: varchar('room_name', { length: 100 }).notNull().unique(),
  gameState: json('game_state').notNull(),
  maxPlayers: integer('max_players').notNull().default(20),  
  currentPlayers: integer('current_players').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  lastActivity: timestamp('last_activity').notNull().defaultNow(),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

const roomAssignments = pgTable('room_assignments', {
  id: serial('id').primaryKey(),
  userId: varchar('user_id', { length: 255 }).notNull(),
  roomName: varchar('room_name', { length: 100 }).notNull(),
  playerName: varchar('player_name', { length: 100 }),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
  lastSeen: timestamp('last_seen').notNull().defaultNow(),
  isActive: boolean('is_active').notNull().default(true),
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

type ColorName = 'blue' | 'green' | 'orange' | 'rainbow' | 'skull';

interface RoomState {
  engine: Matter.Engine;
  roomName: string;
  interval: NodeJS.Timeout;
  score: number;
  nextBallColor: ColorName;
  ballIdCounter: number;
  players: Map<string, { id: string; name: string; connected: boolean, avatarUrl?: string }>;
}

interface GameBall {
  id: number;
  x: number;
  y: number;
  color: ColorName;
  playerId?: string; // Player ID who dropped this ball
  angle?: number; // Rotation angle for physics
}

interface GameStateUpdate {
  balls: GameBall[];
  score: number;
  nextBallColor: ColorName;
  players: Array<{ id: string; name: string; connected: boolean, avatarUrl?: string }>;
}

const rooms = new Map<string, RoomState>();
const { Engine, World, Bodies, Events, Sleeping, Body } = Matter;

// Prevent concurrent duplicate assignments for the same user
const pendingAssignments = new Map<string, Promise<string>>();

const getRandomColor = (): ColorName => {
  const rand = Math.random() * 100; // Get a number between 0 and 100
  if (rand < 10) return 'rainbow'; // 10%
  if (rand < 30) return 'skull';   // 20% (10 + 20)
  
  // Remaining 70% is for the 3 colors
  const remainingColors: ColorName[] = ['blue', 'green', 'orange'];
  return remainingColors[Math.floor(Math.random() * remainingColors.length)];
};

const BALL_RADIUS = 20;
const BALL_DIAMETER = BALL_RADIUS * 2;

// Persistence functions
interface SerializableGameState {
  balls: Array<{
    id: number;
    x: number;
    y: number;
    color: ColorName;
    playerId?: string;
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
          playerId: body.label.split('-')[3], // Player ID who dropped this ball
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

// Matchmaking functions
const findOrCreateRoomForUser = async (userId: string, playerName: string, maxPlayers: number = 20): Promise<string> => {
  if (!db) {
    // Fallback without database
    return `room-${Date.now()}`;
  }

  // Serialize concurrent requests per user to avoid duplicate inserts
  if (pendingAssignments.has(userId)) {
    return await pendingAssignments.get(userId)!;
  }

  const op = (async () => {
    try {
      // Check if user is already assigned to an active room
      const existingAssignment = await db
        .select()
        .from(roomAssignments)
        .where(and(
          eq(roomAssignments.userId, userId),
          eq(roomAssignments.isActive, true)
        ))
        .limit(1);

      if (existingAssignment.length > 0) {
        const roomName = existingAssignment[0].roomName;
        console.log(`User ${userId} already assigned to room: ${roomName}`);

        // Refresh lastSeen and ensure playerName is up to date
        await db
          .update(roomAssignments)
          .set({ lastSeen: new Date(), playerName })
          .where(and(
            eq(roomAssignments.userId, userId),
            eq(roomAssignments.roomName, roomName),
            eq(roomAssignments.isActive, true)
          ));

        return roomName;
      }

      // Find available room with space
      const availableRooms = await db
        .select()
        .from(gameRooms)
        .where(and(
          eq(gameRooms.isActive, true),
          // currentPlayers < maxPlayers (we'll implement this check in memory for now)
        ));

      for (const room of availableRooms) {
        // Check current player count in memory
        const roomState = rooms.get(room.roomName);
        if (roomState && roomState.players.size < maxPlayers) {
          // Assign user to this room
          await assignUserToRoom(userId, room.roomName, playerName);
          return room.roomName;
        }
      }

      // No available room found, create new one
      const newRoomName = `room-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      console.log(`Creating new room: ${newRoomName} for user: ${userId}`);

      // Create room in database
      await db
        .insert(gameRooms)
        .values({
          roomName: newRoomName,
          gameState: {
            balls: [],
            score: 0,
            nextBallColor: 'blue',
            ballIdCounter: 0
          } as any,
          maxPlayers,
          currentPlayers: 0,
          isActive: true,
          lastActivity: new Date(),
        });

      // Assign user to new room
      await assignUserToRoom(userId, newRoomName, playerName);

      return newRoomName;
    } catch (error) {
      console.error('Error in findOrCreateRoomForUser:', error);
      // Fallback to simple room assignment
      return `fallback-room-${Date.now()}`;
    }
  })();

  pendingAssignments.set(userId, op);
  try {
    return await op;
  } finally {
    pendingAssignments.delete(userId);
  }
};

const assignUserToRoom = async (userId: string, roomName: string, playerName: string) => {
  if (!db) return;

  try {
    // If already active in this room, refresh and exit (idempotent)
    const existingActiveSameRoom = await db
      .select()
      .from(roomAssignments)
      .where(and(
        eq(roomAssignments.userId, userId),
        eq(roomAssignments.roomName, roomName),
        eq(roomAssignments.isActive, true),
      ))
      .limit(1);

    if (existingActiveSameRoom.length > 0) {
      await db
        .update(roomAssignments)
        .set({ lastSeen: new Date(), playerName })
        .where(eq(roomAssignments.id, existingActiveSameRoom[0].id));
      return;
    }

    // Deactivate any other active assignments for this user
    await db
      .update(roomAssignments)
      .set({ isActive: false })
      .where(eq(roomAssignments.userId, userId));

    // Insert new active assignment
    await db
      .insert(roomAssignments)
      .values({
        userId,
        roomName,
        playerName,
        joinedAt: new Date(),
        lastSeen: new Date(),
        isActive: true,
      });

    console.log(`Assigned user ${userId} (${playerName}) to room: ${roomName}`);
  } catch (error) {
    console.error('Error assigning user to room:', error);
  }
};

const removeUserFromRoom = async (userId: string, roomName: string) => {
  if (!db) return;

  try {
    await db
      .update(roomAssignments)
      .set({ 
        isActive: false,
        lastSeen: new Date()
      })
      .where(and(
        eq(roomAssignments.userId, userId),
        eq(roomAssignments.roomName, roomName)
      ));

    console.log(`Removed user ${userId} from room: ${roomName}`);
  } catch (error) {
    console.error('Error removing user from room:', error);
  }
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
      playerId: body.label.split('-')[3], // Player ID who dropped this ball
      angle: body.angle, // Rotation angle for physics
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
  if (balls.length < 3) return;

  const visited = new Set<Matter.Body>();
  const groupsToRemove: Matter.Body[][] = [];
  const POP_DISTANCE = BALL_DIAMETER + 2;

  const getColorFromLabel = (label: string): ColorName => label.split('-')[1] as ColorName;
  const isClose = (b1: Matter.Body, b2: Matter.Body) => Math.hypot(b1.position.x - b2.position.x, b1.position.y - b2.position.y) <= POP_DISTANCE;

  // First, find groups of standard colors (wildcarded with rainbows)
  for (const ball of balls) {
      if (visited.has(ball)) continue;

      const color = getColorFromLabel(ball.label);
      if (color === 'skull' || color === 'rainbow') continue;

      const group: Matter.Body[] = [];
      const q: Matter.Body[] = [ball];
      visited.add(ball);

      let head = 0;
      while(head < q.length) {
          const current = q[head++];
          group.push(current);

          for (const neighbor of balls) {
              if (!visited.has(neighbor) && isClose(current, neighbor)) {
                  const neighborColor = getColorFromLabel(neighbor.label);
                  if (neighborColor === color || neighborColor === 'rainbow') {
                      visited.add(neighbor);
                      q.push(neighbor);
                  }
              }
          }
      }

      if (group.length >= 3) {
          groupsToRemove.push(group);
      }
  }

  // Second, find groups of only rainbows
  for (const ball of balls) {
      if (visited.has(ball)) continue;
      const color = getColorFromLabel(ball.label);
      if (color !== 'rainbow') continue;

      const group: Matter.Body[] = [];
      const q: Matter.Body[] = [ball];
      visited.add(ball);
      
      let head = 0;
      while(head < q.length) {
          const current = q[head++];
          group.push(current);

          for (const neighbor of balls) {
              if (!visited.has(neighbor) && isClose(current, neighbor)) {
                  if (getColorFromLabel(neighbor.label) === 'rainbow') {
                      visited.add(neighbor);
                      q.push(neighbor);
                  }
              }
          }
      }

      if (group.length >= 3) {
          groupsToRemove.push(group);
      }
  }

  if (groupsToRemove.length > 0) {
      const allBallsToRemove = new Set<Matter.Body>();

      for (const group of groupsToRemove) {
          const rainbowBallsInGroup: Matter.Body[] = [];
          let hasRainbow = false;
          let matchColor: ColorName | null = null;

          for (const b of group) {
              const c = getColorFromLabel(b.label);
              if (c === 'rainbow') {
                  hasRainbow = true;
                  rainbowBallsInGroup.push(b);
              } else {
                  matchColor = c;
              }
          }

          // Add the initial group to removal list
          group.forEach(b => allBallsToRemove.add(b));

          if (hasRainbow) {
              if (matchColor) {
                  // Clear all balls of the matched color
                  balls.forEach(b => {
                      if (getColorFromLabel(b.label) === matchColor) {
                          allBallsToRemove.add(b);
                      }
                  });
              } else {
                  // A pure rainbow group clears all balls except skulls initially
                   balls.forEach(b => {
                      if (getColorFromLabel(b.label) !== 'skull') {
                          allBallsToRemove.add(b);
                      }
                  });
              }

              // Any rainbow ball in a match can clear adjacent skulls
              for (const rBall of rainbowBallsInGroup) {
                  for (const other of balls) {
                      if (getColorFromLabel(other.label) === 'skull' && isClose(rBall, other)) {
                          allBallsToRemove.add(other);
                      }
                  }
              }
          }
      }

      if (allBallsToRemove.size > 0) {
          const ballsToRemoveArray = Array.from(allBallsToRemove);

          for (const ball of balls) {
            if (allBallsToRemove.has(ball)) continue;
            for (const removedBall of ballsToRemoveArray) {
              const isAbove = ball.position.y < removedBall.position.y;
              const dist = Math.hypot(ball.position.x - removedBall.position.x, ball.position.y - removedBall.position.y);
              if (isAbove && dist < BALL_DIAMETER * 1.5) {
                Sleeping.set(ball, false);
                break;
              }
            }
          }

          World.remove(engine.world, ballsToRemoveArray);
          
          const totalPopped = ballsToRemoveArray.length;
          roomState.score += totalPopped * 10;
          console.log(`Room ${roomState.roomName}: Popped ${totalPopped} balls, score now ${roomState.score}`);
          
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
        label: `ball-${ballData.color}-${ballData.id}-${ballData.playerId || 'unknown'}`,
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

  // New matchmaking endpoint
  socket.on('findRoom', async ({ userId, name, maxPlayers = 20 }: { userId: string, name?: string, maxPlayers?: number }) => {
    try {
      const playerName = name || `Player ${userId.slice(0, 6)}`;
      const assignedRoom = await findOrCreateRoomForUser(userId, playerName, maxPlayers);
      
      console.log(`User ${userId} assigned to room: ${assignedRoom}`);
      
      // Send room assignment back to client
      socket.emit('roomAssigned', { 
        roomName: assignedRoom,
        userId,
        playerName 
      });
      
    } catch (error) {
      console.error('Error in findRoom:', error);
      socket.emit('roomError', { message: 'Failed to find room' });
    }
  });

  socket.on('joinRoom', async ({ roomName, name, userId, avatarUrl }: { roomName: string, name?: string, userId?: string, avatarUrl?: string }) => {
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
      connected: true,
      avatarUrl
    });

    // Send initial state to joining user
    const balls: GameBall[] = roomState.engine.world.bodies
      .filter(body => body.label.startsWith('ball-'))
      .map(body => ({
        id: parseInt(body.label.split('-')[2]),
        x: body.position.x,
        y: body.position.y,
        color: body.label.split('-')[1] as ColorName,
        playerId: body.label.split('-')[3], // Player ID who dropped this ball
        angle: body.angle, // Rotation angle for physics
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

    // Get the player who dropped the ball
    const player = roomState.players.get(socket.id);
    if (!player) {
      console.log(`Player not found in room ${roomName}`);
      return;
    }

    const { engine } = roomState;
    const ballId = ++roomState.ballIdCounter;
    const ball = Bodies.circle(x, 50, BALL_RADIUS, { 
      label: `ball-${color}-${ballId}-${player.id}`,
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
        
        // Remove from database assignment immediately
        removeUserFromRoom(player.id, roomName);
        
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
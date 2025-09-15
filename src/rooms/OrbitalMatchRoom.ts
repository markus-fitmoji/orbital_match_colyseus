import { Room, Client } from "colyseus";
import { GameState, Ball, Player, ColorName } from "../schema/GameState";
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

// Database connection
const connectionString = process.env.DATABASE_URL || '';
const client = postgres(connectionString);
const db = drizzle(client);

const { Engine, World, Bodies, Events, Sleeping, Body } = Matter;

const colorNames: ColorName[] = ['blue', 'green', 'orange'];
const getRandomColor = (): ColorName => colorNames[Math.floor(Math.random() * colorNames.length)];

const BALL_RADIUS = 20;
const BALL_DIAMETER = BALL_RADIUS * 2;

interface DropBallMessage {
  x: number;
  color: ColorName;
}

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

export class OrbitalMatchRoom extends Room<GameState> {
  private engine!: Matter.Engine;
  private gameLoopInterval!: NodeJS.Timeout;
  private settleFrames = 0;
  private readonly REQUIRED_SETTLE_FRAMES = 8;
  private readonly SPEED_EPS = 0.15;

  async onCreate(options: any) {
    this.setState(new GameState());
    
    console.log("OrbitalMatchRoom created!", options);

    // Initialize physics engine
    this.initializePhysics();

    // Try to load existing game state
    await this.loadGameState();

    // Set up message handlers
    this.onMessage("dropBall", (client, message: DropBallMessage) => {
      this.dropBall(client, message.x, message.color);
    });

    this.onMessage("resetGame", (client) => {
      this.resetGame();
    });

    // Start game loop
    this.gameLoopInterval = setInterval(() => {
      this.updatePhysics();
      this.syncGameState();
    }, 1000 / 60);

    // Set up auto-save
    this.clock.setInterval(() => {
      this.saveGameState();
    }, 5000); // Save every 5 seconds
  }

  async onJoin(client: Client, options: any) {
    console.log(client.sessionId, "joined!");

    // Add player to game state
    const player = new Player();
    player.id = client.sessionId;
    player.name = options.name || `Player ${client.sessionId.slice(0, 6)}`;
    player.connected = true;

    this.state.players.set(client.sessionId, player);

    // Send current game state to joining player
    client.send("gameStateUpdate", {
      balls: Array.from(this.state.balls.values()),
      score: this.state.score,
      nextBallColor: this.state.nextBallColor,
      players: Array.from(this.state.players.values())
    });
  }

  async onLeave(client: Client, consented: boolean) {
    console.log(client.sessionId, "left!");

    const player = this.state.players.get(client.sessionId);
    if (player) {
      player.connected = false;
      
      // Remove player after 30 seconds if they don't reconnect
      this.clock.setTimeout(() => {
        if (!player.connected) {
          this.state.players.delete(client.sessionId);
        }
      }, 30000);
    }
  }

  onDispose() {
    console.log("room", this.roomId, "disposing...");
    
    if (this.gameLoopInterval) {
      clearInterval(this.gameLoopInterval);
    }

    // Save final state
    this.saveGameState();
  }

  private initializePhysics() {
    this.engine = Engine.create();
    this.engine.world.gravity.y = 1;
    this.engine.enableSleeping = true;

    // Create walls
    const width = 400;
    const height = 700;
    const wallThickness = 40;
    
    const walls = [
      Bodies.rectangle(width / 2, -wallThickness / 2, width, wallThickness, { isStatic: true }),
      Bodies.rectangle(width / 2, height + wallThickness / 2 - 30, width, wallThickness, { isStatic: true }),
      Bodies.rectangle(-wallThickness / 2, height / 2, wallThickness, height, { isStatic: true }),
      Bodies.rectangle(width + wallThickness / 2, height / 2, wallThickness, height, { isStatic: true }),
    ];
    World.add(this.engine.world, walls);

    // Set up physics events for match checking
    Events.on(this.engine, 'afterUpdate', () => {
      const balls = this.engine.world.bodies.filter(b => b.label.startsWith('ball-'));
      if (balls.length === 0) return;
      
      const allStill = balls.every(b => b.isSleeping || Math.hypot(b.velocity.x, b.velocity.y) < this.SPEED_EPS);
      if (allStill) {
        this.settleFrames++;
        if (this.settleFrames >= this.REQUIRED_SETTLE_FRAMES) {
          this.settleFrames = 0;
          this.checkForMatches();
        }
      } else {
        this.settleFrames = 0;
      }
    });
  }

  private updatePhysics() {
    Engine.update(this.engine, 1000 / 60);
  }

  private syncGameState() {
    // Update ball positions from physics engine
    const physicsBalls = this.engine.world.bodies.filter(body => body.label.startsWith('ball-'));
    
    // Remove balls that no longer exist in physics
    for (const [ballId, ball] of this.state.balls.entries()) {
      const physicsBody = physicsBalls.find(b => parseInt(b.label.split('-')[2]) === ball.id);
      if (!physicsBody) {
        this.state.balls.delete(ballId);
      }
    }

    // Update existing balls and add new ones
    for (const physicsBody of physicsBalls) {
      const ballId = parseInt(physicsBody.label.split('-')[2]);
      let ball = this.state.balls.get(ballId.toString());
      
      if (!ball) {
        ball = new Ball();
        ball.id = ballId;
        ball.color = physicsBody.label.split('-')[1] as ColorName;
        this.state.balls.set(ballId.toString(), ball);
      }
      
      ball.x = physicsBody.position.x;
      ball.y = physicsBody.position.y;
      ball.velocityX = physicsBody.velocity.x;
      ball.velocityY = physicsBody.velocity.y;
      ball.angle = physicsBody.angle;
      ball.angularVelocity = physicsBody.angularVelocity;
    }
  }

  private dropBall(client: Client, x: number, color: ColorName) {
    const ballId = ++this.state.ballIdCounter;
    const ball = Bodies.circle(x, 50, BALL_RADIUS, { 
      label: `ball-${color}-${ballId}`,
      restitution: 0.5,
      friction: 0.02,
      frictionAir: 0.001,
    });
    
    World.add(this.engine.world, ball);
    this.state.nextBallColor = getRandomColor();
    
    console.log(`Ball dropped by ${client.sessionId} at x=${x}, color=${color}, id=${ballId}`);
  }

  private checkForMatches() {
    const balls = this.engine.world.bodies.filter(b => b.label.startsWith('ball-'));
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

      // Wake up balls that might be affected by removal
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
        World.remove(this.engine.world, group);
        totalPopped += group.length;
      }

      if (totalPopped > 0) {
        this.state.score += totalPopped * 10;
        console.log(`Room ${this.roomId}: Popped ${totalPopped} balls, score now ${this.state.score}`);
        
        // Broadcast match event to all clients
        this.broadcast("ballsPopped", { count: totalPopped, newScore: this.state.score });
      }
    }
  }

  private resetGame() {
    // Remove all balls from physics
    const balls = this.engine.world.bodies.filter(b => b.label.startsWith('ball-'));
    World.remove(this.engine.world, balls);
    
    // Reset game state
    this.state.balls.clear();
    this.state.score = 0;
    this.state.nextBallColor = getRandomColor();
    this.state.ballIdCounter = 0;
    
    console.log(`Game reset in room ${this.roomId}`);
    this.broadcast("gameReset", {});
  }

  private async saveGameState() {
    try {
      const gameState: SerializableGameState = {
        balls: Array.from(this.state.balls.values()).map(ball => ({
          id: ball.id,
          x: ball.x,
          y: ball.y,
          color: ball.color,
          velocityX: ball.velocityX,
          velocityY: ball.velocityY,
          angle: ball.angle,
          angularVelocity: ball.angularVelocity,
        })),
        score: this.state.score,
        nextBallColor: this.state.nextBallColor,
        ballIdCounter: this.state.ballIdCounter,
      };

      await db
        .insert(gameRooms)
        .values({
          roomName: this.roomId,
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

      console.log(`Saved state for room: ${this.roomId}`);
    } catch (error) {
      console.error(`Failed to save room state for ${this.roomId}:`, error);
    }
  }

  private async loadGameState() {
    try {
      const result = await db
        .select()
        .from(gameRooms)
        .where(eq(gameRooms.roomName, this.roomId))
        .limit(1);

      if (result.length > 0) {
        const savedState = result[0].gameState as SerializableGameState;
        
        // Restore game state
        this.state.score = savedState.score;
        this.state.nextBallColor = savedState.nextBallColor;
        this.state.ballIdCounter = savedState.ballIdCounter;

        // Restore balls
        for (const ballData of savedState.balls) {
          // Add to physics engine
          const ball = Bodies.circle(ballData.x, ballData.y, BALL_RADIUS, {
            label: `ball-${ballData.color}-${ballData.id}`,
            restitution: 0.5,
            friction: 0.02,
            frictionAir: 0.001,
          });
          
          Body.setVelocity(ball, { x: ballData.velocityX, y: ballData.velocityY });
          Body.setAngle(ball, ballData.angle);
          Body.setAngularVelocity(ball, ballData.angularVelocity);
          
          World.add(this.engine.world, ball);

          // Add to Colyseus state
          const stateBall = new Ball();
          stateBall.id = ballData.id;
          stateBall.x = ballData.x;
          stateBall.y = ballData.y;
          stateBall.color = ballData.color;
          stateBall.velocityX = ballData.velocityX;
          stateBall.velocityY = ballData.velocityY;
          stateBall.angle = ballData.angle;
          stateBall.angularVelocity = ballData.angularVelocity;
          
          this.state.balls.set(ballData.id.toString(), stateBall);
        }

        console.log(`Loaded state for room: ${this.roomId} with ${savedState.balls.length} balls`);
      }
    } catch (error) {
      console.error(`Failed to load room state for ${this.roomId}:`, error);
    }
  }
}

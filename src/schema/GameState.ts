import { Schema, type, MapSchema } from "@colyseus/schema";

export type ColorName = 'blue' | 'green' | 'orange';

export class Ball extends Schema {
  @type("number") id: number = 0;
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("string") color: ColorName = 'blue';
  @type("number") velocityX: number = 0;
  @type("number") velocityY: number = 0;
  @type("number") angle: number = 0;
  @type("number") angularVelocity: number = 0;
}

export class Player extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "";
  @type("boolean") connected: boolean = true;
}

export class GameState extends Schema {
  @type({ map: Ball }) balls = new MapSchema<Ball>();
  @type({ map: Player }) players = new MapSchema<Player>();
  @type("number") score: number = 0;
  @type("string") nextBallColor: ColorName = 'blue';
  @type("number") ballIdCounter: number = 0;
  @type("boolean") gameActive: boolean = true;
}

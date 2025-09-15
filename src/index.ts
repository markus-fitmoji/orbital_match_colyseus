import { Server } from "colyseus";
import { createServer } from "http";
import express from "express";
import { OrbitalMatchRoom } from "./rooms/OrbitalMatchRoom";

const port = Number(process.env.PORT || 2567);
const app = express();

// Create HTTP & WebSocket servers
const server = createServer(app);
const gameServer = new Server({
  server,
});

// Register room handlers
gameServer.define('orbital_match', OrbitalMatchRoom);

// Health check endpoint
app.get("/", (req, res) => {
  res.send("Orbital Match Colyseus Server is running!");
});

// Health check for monitoring
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString()
  });
});

gameServer.listen(port);
console.log(`Colyseus server listening on ws://localhost:${port}`);

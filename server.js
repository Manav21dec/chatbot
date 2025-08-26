const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const WebSocket = require('ws');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// System instructions for Revolt Motors
const SYSTEM_INSTRUCTIONS = `You are Rev, the AI assistant for Revolt Motors, India's leading electric motorcycle company. You should only discuss topics related to Revolt Motors, their electric motorcycles (RV1, RV1+, RV400), specifications, features, pricing, dealerships, test rides, and general information about electric vehicles.

Key information about Revolt Motors:
- Founded in 2019 by Rahul Sharma
- Headquartered in Gurugram, India
- Manufactures premium electric motorcycles
- Popular models: RV1, RV1+, RV400
- Focus on sustainable mobility and innovation
- Offers features like AI-enabled connectivity, mobile app integration
- Has dealerships across major Indian cities

If users ask about topics unrelated to Revolt Motors or electric motorcycles, politely redirect them back to Revolt Motors topics. Keep responses conversational, helpful, and enthusiastic about electric mobility.`;

// Store active connections
const activeConnections = new Map();

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('start-voice-session', async () => {
    try {
      const geminiWs = new WebSocket('wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent', {
        headers: {
          'Content-Type': 'application/json',
        }
      });

      // Store the connection
      activeConnections.set(socket.id, {
        geminiWs,
        socket,
        isConnected: false
      });

      geminiWs.on('open', () => {
        console.log('Connected to Gemini Live API');
        
        // Setup session with system instructions
        const setupMessage = {
          setup: {
            model: `models/${process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-001'}`,
            generation_config: {
              response_modalities: ['AUDIO'],
              speech_config: {
                voice_config: {
                  prebuilt_voice_config: {
                    voice_name: 'Aoede'
                  }
                }
              }
            },
            system_instruction: {
              parts: [{
                text: SYSTEM_INSTRUCTIONS
              }]
            },
            tools: [],
          }
        };

        geminiWs.send(JSON.stringify(setupMessage));
        
        const connection = activeConnections.get(socket.id);
        if (connection) {
          connection.isConnected = true;
          socket.emit('session-ready');
        }
      });

      geminiWs.on('message', (data) => {
        try {
          const response = JSON.parse(data.toString());
          
          if (response.serverContent?.modelTurn?.parts) {
            for (const part of response.serverContent.modelTurn.parts) {
              if (part.inlineData?.mimeType === 'audio/pcm') {
                // Send audio data back to client
                socket.emit('audio-response', {
                  audio: part.inlineData.data,
                  mimeType: part.inlineData.mimeType
                });
              }
            }
          }

          if (response.serverContent?.turnComplete) {
            socket.emit('turn-complete');
          }

        } catch (error) {
          console.error('Error parsing Gemini response:', error);
        }
      });

      geminiWs.on('error', (error) => {
        console.error('Gemini WebSocket error:', error);
        socket.emit('error', { message: 'Connection to AI service failed' });
      });

      geminiWs.on('close', () => {
        console.log('Gemini WebSocket closed');
        activeConnections.delete(socket.id);
        socket.emit('session-ended');
      });

    } catch (error) {
      console.error('Error starting voice session:', error);
      socket.emit('error', { message: 'Failed to start voice session' });
    }
  });

  socket.on('audio-input', (audioData) => {
    const connection = activeConnections.get(socket.id);
    if (connection && connection.isConnected && connection.geminiWs.readyState === WebSocket.OPEN) {
      const message = {
        clientContent: {
          turns: [{
            parts: [{
              inlineData: {
                mimeType: 'audio/pcm',
                data: audioData.audio
              }
            }]
          }],
          turnComplete: true
        }
      };

      connection.geminiWs.send(JSON.stringify(message));
    }
  });

  socket.on('interrupt', () => {
    const connection = activeConnections.get(socket.id);
    if (connection && connection.geminiWs.readyState === WebSocket.OPEN) {
      const interruptMessage = {
        clientContent: {
          turns: [{
            parts: [{
              text: "INTERRUPT"
            }]
          }],
          turnComplete: true
        }
      };
      connection.geminiWs.send(JSON.stringify(interruptMessage));
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const connection = activeConnections.get(socket.id);
    if (connection && connection.geminiWs) {
      connection.geminiWs.close();
    }
    activeConnections.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Make sure to set your GEMINI_API_KEY in the .env file`);
});
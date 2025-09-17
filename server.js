// server.js — Infobip <-> OpenAI Realtime (minimal)
import 'dotenv/config';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';

const PORT  = process.env.PORT || 8080;
const MODEL = process.env.OAI_REALTIME_MODEL || 'gpt-realtime';
const OAI_URL = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
const OAI_HEADERS = { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };

// 20ms PCM16 mono frame sizes
const FRAME_16K = 640, FRAME_8K = 320;
const chunk20 = (buf, n) => Array.from({length: Math.floor(buf.length/n)}, (_,i)=>buf.subarray(i*n,(i+1)*n));

const server = http.createServer((req,res)=>{
  res.writeHead(200,{'content-type':'text/plain'}); res.end('OK');
});

const wss = new WebSocketServer({ server, path: '/realtime' });

wss.on('connection', (ib) => {
  let frameBytes = FRAME_16K;
  let oai;

  // Open OpenAI Realtime session
  const openOAI = () => new Promise((resolve, reject) => {
    oai = new WebSocket(OAI_URL, { headers: OAI_HEADERS });
    oai.on('open', () => {
      oai.send(JSON.stringify({
        type:'session.update',
        session:{
          voice:'alloy',
          input_audio_format:'pcm16',
          turn_detection:{ type:'server_vad', create_response:true },
          instructions:"You are the call assistant for Befinity AI. Be concise and helpful."
        }
      }));
      oai.send(JSON.stringify({
        type:'response.create',
        response:{
          modalities:['audio'],
          instructions:
            "Hello, you’re speaking with the AI assistant for Befinity AI. " +
            "I can help with questions about our workshops and your registration confirmations. " +
            "Say 'human' or press 0 for a person."
        }
      }));
      resolve();
    });
    oai.on('message', (d,isBin)=>{
      if (isBin) return;
      try {
        const evt = JSON.parse(d.toString());
        const b64 = evt?.delta?.audio || evt?.data?.audio || evt?.audio;
        if (!b64) return;
        const raw = Buffer.from(b64, 'base64');
        for (const f of chunk20(raw, frameBytes)) ib.send(f, { binary:true });
      } catch {}
    });
    oai.on('error', reject);
  });

  // Handle Infobip messages
  ib.on('message', async (msg, isBinary) => {
    if (!isBinary) {
      try {
        const evt = JSON.parse(msg.toString());
        if (evt.event === 'websocket:connected' && evt['content-type']) {
          const m = /rate=(\d+)/.exec(evt['content-type']);
          frameBytes = (m && m[1] === '8000') ? FRAME_8K : FRAME_16K;
          await openOAI();
        }
        if (evt.event === 'websocket:dtmf' && evt.digit === '0') {
          oai?.send(JSON.stringify({ type:'response.cancel' }));
          // Next: your app can call Infobip "connect" to transfer to a human.
        }
      } catch {}
      return;
    }
    // Binary = 20ms PCM16 frame from caller
    if (oai?.readyState === WebSocket.OPEN) {
      oai.send(JSON.stringify({ type:'input_audio_buffer.append', audio: msg.toString('base64') }));
    }
  });

  const end = ()=>{ try{oai?.close();}catch{}; try{ib?.close();}catch{}; };
  ib.on('close', end); ib.on('error', end);
});

server.listen(PORT, ()=>console.log(`OK :${PORT} | WS /realtime`));

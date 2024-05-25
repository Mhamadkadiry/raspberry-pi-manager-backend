const express = require('express');
const drivelist = require('drivelist');
const cors = require('cors');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const port = 5000;

app.use(cors());
app.use(bodyParser.json());
const osVersions = {
    'Raspberry Pi OS (32-bit)': true,
    'Raspberry Pi OS (64-bit)': false,
};
const models64Bit = [
    '3b', '3b+', '3a+', '4b', '400', '5', 'CM3', 'CM3+', 'CM4', 'CM4S', 'Zero2W'
];

const wss = new WebSocket.Server({ port: 8080 });

let clients = [];

wss.on('connection', (ws) => {
  clients.push(ws);
  ws.on('close', () => {
    clients = clients.filter(client => client !== ws);
  });
});

function broadcast(message) {
  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

app.get('/api/drives', async (req, res) => {
    try {
        const drives = await drivelist.list();
        const externalDrives = drives.filter(drive => drive.isUSB || drive.isCard);
        res.json(externalDrives);
    } catch (error) {
        res.status(500).send('Error listing drives');
    }
});

app.get('/os-versions', (req, res) => {
    const { model } = req.query;
  
    const is64BitSupported = models64Bit.includes(model);
    console.log(model)
    console.log(models64Bit.includes(model))
    const availableVersions = Object.keys(osVersions).filter(version => {
      return osVersions[version] || is64BitSupported;
    });
  
    res.json({ availableVersions });
});

app.post('/api/install', (req, res) => {
  const { selectedOs, storage } = req.body;

  const osImages = {
    'Raspberry Pi OS (32-bit)': 'arm.img.xz',
    'Raspberry Pi OS (64-bit)': 'arm64.img.xz',
  };

  const osImageFile = osImages[selectedOs];

  if (!osImageFile) {
    return res.status(400).json({ error: 'Invalid OS selection' });
  }

  const imagePath = path.join(__dirname, 'os_images', osImageFile);
  const devicePath = storage.device || storage.raw;

  if (!devicePath) {
    return res.status(400).json({ error: 'Invalid storage device' });
  }

  const writeCommand = `xzcat ${imagePath} | sudo dd of=${devicePath} bs=4M status=progress`;

  const dd = spawn('sh', ['-c', writeCommand]);

  dd.stdout.on('data', (data) => {
    console.log("data"+data);
    const output = data.toString();
    const progressMatch = output.match(/(\d+)%/);
    if (progressMatch) {
      console.log(progressMatch);
      console.log(output);
      console.log(progressMatch);
      const progress = parseInt(progressMatch[1], 10);
      broadcast({ type: 'progress', progress });
    }
  });

  dd.stderr.on('data', (data) => {
    console.error(`stderr: ${data}`);
  });

  dd.on('close', (code) => {
    if (code === 0) {
      broadcast({ type: 'done' });
      res.json({ message: 'OS image installed successfully' });
    } else {
      broadcast({ type: 'error', message: 'Failed to write OS image' });
      res.status(500).json({ error: 'Failed to write OS image' });
    }
  });
});

  
app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

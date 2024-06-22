const express = require('express');
const drivelist = require('drivelist');
const cors = require('cors');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const fs = require('fs');
const bcrypt = require('bcryptjs');

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
    const availableVersions = Object.keys(osVersions).filter(version => {
      return osVersions[version] || is64BitSupported;
    });
  
    res.json({ availableVersions });
});

function createSshFile(bootPath) {
    const sshFilePath = path.join(bootPath, 'ssh');
    fs.writeFileSync(sshFilePath, '');
}

function createUserConfFile(bootPath, username, hashedPassword) {
    const userConfPath = path.join(bootPath, 'userconf');
    const userConfContent = `${username}:${hashedPassword}`;
    fs.writeFileSync(userConfPath, userConfContent);
}
function setupTpmScript(bootPath) {
  // Example script content, replace with actual TPM setup script content
  const tpmSetupScript = `
#!/bin/bash
# Step one: Update the package list and upgrade installed packages
echo "Updating and upgrading packages..."
sudo apt update && sudo apt upgrade -y

# Step two: Enable SPI and load TPM device tree overlay
echo "Configuring /boot/config.txt for SPI and TPM..."

# Backup the current config.txt
sudo cp /boot/config.txt /boot/config.txt.backup

# Add SPI and TPM configuration if not already present
grep -q "^dtparam=spi=on" /boot/config.txt || echo "dtparam=spi=on" | sudo tee -a /boot/config.txt
grep -q "^dtoverlay=tpm-slb9670" /boot/config.txt || echo "dtoverlay=tpm-slb9670" | sudo tee -a /boot/config.txt

`;

  const tpmScriptPath = path.join(bootPath, 'tpm_setup.sh');
  fs.writeFileSync(tpmScriptPath, tpmSetupScript);
  fs.chmodSync(tpmScriptPath, '755'); // Make the script executable
}
app.post('/api/install', (req, res) => {
  const { selectedOs, storage, username, password, tpmSetup} = req.body;
  console.log(tpmSetup)
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

  bcrypt.hash(password, 10, (err, hashedPassword) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to hash password' });
    }

    const dd = spawn('sh', ['-c', writeCommand]);

    dd.stdout.on('data', (data) => {
      const output = data.toString();
      const progressMatch = output.match(/(\d+)%/);
      if (progressMatch) {
        const progress = parseInt(progressMatch[1], 10);
        broadcast({ type: 'progress', progress });
      }
    });

    dd.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`);
    });

    dd.on('close', (code) => {
      if (code === 0) {
        // Find the boot partition
        drivelist.list().then((drives) => {
          const bootPartition = drives.find(drive => (drive.isUSB || drive.isCard) && drive.mountpoints.some(mp => mp.path.includes('boot')));
          if (bootPartition) {
            const bootPath = bootPartition.mountpoints.find(mp => mp.path.includes('boot')).path;
            createSshFile(bootPath);
            createUserConfFile(bootPath, username, hashedPassword);
            if (tpmSetup) {
              console.log(tpmSetup)
              console.log(bootPath)
              setupTpmScript(bootPath);
            }
            broadcast({ type: 'done' });
            res.json({ message: 'OS image installed successfully' });
          } else {
            broadcast({ type: 'error', message: 'Failed to find boot partition' });
            res.status(500).json({ error: 'Failed to find boot partition' });
          }
        }).catch(error => {
          broadcast({ type: 'error', message: 'Failed to list drives' });
          res.status(500).json({ error: 'Failed to list drives' });
        });
      } else {
        broadcast({ type: 'error', message: 'Failed to write OS image' });
        res.status(500).json({ error: 'Failed to write OS image' });
      }
    });
  });
});

app.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
});

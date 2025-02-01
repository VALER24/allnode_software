const express = require('express');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const port = 3030;

// Middleware to parse form data
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public')); // Serve static files (HTML, CSS, JS)

// URL for the CSV file
const ysfCsvUrl = 'https://register.ysfreflector.de/export_csv.php';
const ysfJsonPath = path.join(__dirname, 'ysf.json');

// Function to download the YSF CSV file
function downloadYsfCsv(url, destination, callback) {
    const file = fs.createWriteStream(destination);

    https.get(url, (response) => {
        if (response.statusCode === 200) {
            response.pipe(file);
            file.on('finish', () => {
                file.close(callback);
            });
        } else {
            console.error(`Failed to download file: ${response.statusCode}`);
            callback(new Error(`Failed to download file: ${response.statusCode}`));
        }
    }).on('error', (err) => {
        fs.unlink(destination, () => {}); // Remove incomplete file
        console.error(`Error: ${err.message}`);
        callback(err);
    });
}

// Function to parse the downloaded CSV file
function parseYsfCsv(filePath, outputJsonPath) {
    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error reading file: ${err.message}`);
            return;
        }

        // Split data into rows and parse into objects
        const rows = data.split('\n').filter(row => row.trim().length > 0);
        const result = rows.map(row => {
            const [number, name, description, ip, port, extension, urlDashboard, key] = row.split(';');
            return {
                number: parseInt(number, 10),
                name: name.trim(),
                description: description.trim(),
                ipHostname: ip.trim(),
                port: parseInt(port, 10),
                extension: extension.trim(),
                urlDashboard: urlDashboard.trim(),
                key: parseInt(key, 10),
            };
        });

        // Save result to JSON file
        fs.writeFile(outputJsonPath, JSON.stringify(result, null, 2), (writeErr) => {
            if (writeErr) {
                console.error(`Error writing JSON file: ${writeErr.message}`);
            } else {
                console.log(`Parsed data saved to ${outputJsonPath}`);
            }
        });
    });
}

// Function to update YSF JSON data
function updateYsfData() {
    const tempFile = path.join(__dirname, 'YSFHosts.txt');
    downloadYsfCsv(ysfCsvUrl, tempFile, (err) => {
        if (err) {
            console.error(`Failed to download YSF CSV file: ${err.message}`);
            return;
        }
        console.log('YSF CSV file downloaded successfully!');
        parseYsfCsv(tempFile, ysfJsonPath);
    });
}

// Update YSF data on server startup
updateYsfData();

// Home route to render the dropdown menu
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route to handle mode selection and node/talkgroup input
app.post('/connect', (req, res) => {
    const { mode, nodeNumber, talkgroup } = req.body;

    if (!mode) {
        return res.status(400).send('Mode is required.');
    }

    // Execute commands based on the selected mode
    switch (mode) {
        case 'ALLSTAR':
            if (!nodeNumber) {
                return res.status(400).send('Allstar node number is required.');
            }
            exec(`/usr/sbin/asterisk -rx "rpt cmd 57686 ilink 6 0"`, (err, stdout, stderr) => {
                if (err) {
                    console.error(`Error: ${stderr}`);
                    return res.status(500).send('Failed to execute Allstar command.');
                }
                exec(`/usr/sbin/asterisk -rx "rpt fun 57686 *3${nodeNumber}"`, (err, stdout, stderr) => {
                    if (err) {
                        console.error(`Error: ${stderr}`);
                        return res.status(500).send('Failed to execute Allstar command.');
                    }
                    res.send(`Connected to Allstar node ${nodeNumber}`);
                });
            });
            break;

        case 'ECHOLINK':
            if (!nodeNumber) {
                return res.status(400).send('Echolink node number is required.');
            }
            exec(`/usr/sbin/asterisk -rx "rpt cmd 57686 ilink 6 0"`, (err, stdout, stderr) => {
                if (err) {
                    console.error(`Error: ${stderr}`);
                    return res.status(500).send('Failed to execute Echolink command.');
                }
                exec(`/usr/sbin/asterisk -rx "rpt fun 57686 *33${nodeNumber}"`, (err, stdout, stderr) => {
                    if (err) {
                        console.error(`Error: ${stderr}`);
                        return res.status(500).send('Failed to execute Echolink command.');
                    }
                    res.send(`Connected to Echolink node ${nodeNumber}`);
                });
            });
            break;

        case 'YSF': // Handle YSF differently
            if (!talkgroup) {
                return res.status(400).send('Talkgroup is required.');
            }
            // Load YSF JSON data
            fs.readFile(ysfJsonPath, 'utf8', (err, data) => {
                if (err) {
                    console.error(`Error reading YSF JSON file: ${err}`);
                    return res.status(500).send('Failed to load YSF data.');
                }
                const ysfData = JSON.parse(data);
                const ysfEntry = ysfData.find(entry => entry.number === parseInt(talkgroup));
                if (!ysfEntry) {
                    return res.status(400).send(`YSF talkgroup ${talkgroup} not found.`);
                }
                const { ipHostname, port } = ysfEntry;
                const ysfAddress = `${ipHostname}:${port}`;

                // Execute commands for YSF
                exec(`/usr/sbin/asterisk -rx "rpt cmd 57686 ilink 6 0"`, (err, stdout, stderr) => {
                    if (err) {
                        console.error(`Error: ${stderr}`);
                        return res.status(500).send('Failed to execute command.');
                    }
                    exec(`/usr/sbin/asterisk -rx "rpt fun 57686 *31999"`, (err, stdout, stderr) => {
                        if (err) {
                            console.error(`Error: ${stderr}`);
                            return res.status(500).send('Failed to execute command.');
                        }
                        exec(`/opt/MMDVM_Bridge/dvswitch.sh mode YSF`, (err, stdout, stderr) => {
                            if (err) {
                                console.error(`Error: ${stderr}`);
                                return res.status(500).send('Failed to set mode.');
                            }
                            exec(`/opt/MMDVM_Bridge/dvswitch.sh tune ${ysfAddress}`, (err, stdout, stderr) => {
                                if (err) {
                                    console.error(`Error: ${stderr}`);
                                    return res.status(500).send('Failed to tune YSF talkgroup.');
                                }
                                res.send(`Connected to YSF talkgroup ${talkgroup} (${ysfAddress})`);
                            });
                        });
                    });
                });
            });
            break;

        case 'BRANDMEISTER':
        case 'DMR':
        case 'NXDN':
        case 'P25':
            if (!talkgroup) {
                return res.status(400).send('Talkgroup is required.');
            }
            exec(`/usr/sbin/asterisk -rx "rpt cmd 57686 ilink 6 0"`, (err, stdout, stderr) => {
                if (err) {
                    console.error(`Error: ${stderr}`);
                    return res.status(500).send('Failed to execute command.');
                }
                exec(`/usr/sbin/asterisk -rx "rpt fun 57686 *31999"`, (err, stdout, stderr) => {
                    if (err) {
                        console.error(`Error: ${stderr}`);
                        return res.status(500).send('Failed to execute command.');
                    }
                    exec(`/opt/MMDVM_Bridge/dvswitch.sh mode STFU`, (err, stdout, stderr) => { // Use STFU for Brandmeister
                        if (err) {
                            console.error(`Error: ${stderr}`);
                            return res.status(500).send('Failed to set mode.');
                        }
                        exec(`/opt/MMDVM_Bridge/dvswitch.sh tune ${talkgroup}`, (err, stdout, stderr) => {
                            if (err) {
                                console.error(`Error: ${stderr}`);
                                return res.status(500).send('Failed to tune talkgroup.');
                            }
                            res.send(`Connected to ${mode} talkgroup ${talkgroup}`);
                        });
                    });
                });
            });
            break;

        default:
            res.status(400).send('Invalid mode selected.');
    }
});

// Route to fetch JSON data for a specific mode
app.get('/data/:mode', (req, res) => {
    const { mode } = req.params;
    let filePath;

    switch (mode) {
        case 'ALLSTAR':
            filePath = '/switchapp/allstar_json/allstardata.json';
            break;
        case 'ECHOLINK':
            filePath = '/switchapp/echolink_json/echolinkdata.json';
            break;
        case 'YSF':
            filePath = ysfJsonPath;
            break;
        case 'P25':
            filePath = '/switchapp/digitalmodes/p25.json';
            break;
        case 'NXDN':
            filePath = '/switchapp/digitalmodes/nxdn.json';
            break;
        case 'DMR':
            filePath = '/switchapp/digitalmodes/dmr_tgif_talkgroups.json';
            break;
        case 'BRANDMEISTER':
            filePath = '/switchapp/digitalmodes/dmr_bm_talkgroups.json';
            break;
        default:
            return res.status(400).send('Invalid mode.');
    }

    fs.readFile(filePath, 'utf8', (err, data) => {
        if (err) {
            console.error(`Error reading file: ${err}`);
            return res.status(500).send('Failed to load data.');
        }
        res.json(JSON.parse(data));
    });
});

// Start the server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

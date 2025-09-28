# MediaProxyAgent
A simple, efficient agent designed to extend Oldcord's WebRTC voice capabilities across multiple geographic regions. <br>
The **Media Proxy Agent** connects directly to your Oldcord Media Relay Signaling Server, enabling you to deploy media servers dedicated solely to voice traffic in different locations (e.g., US-East, EU-Central). This improves latency and quality for users worldwide. <br>

# Features
  - **Regional Voice Deployment**: Easily scale your instance's voice capabilities.
  - **Automatic IP Discovery**: Reports the server's public address (IP/Port) to the Signaling Server for seamless WebRTC connection handling (NAT Traversal).
  - **Efficient Event Forwarding**: Batches and relays real-time events (like speaking_events) from the media server back to the Signaling Server.

# Setup
Before using, please make sure your Oldcord instance has `mr_server` -> `enabled` (set to `true`) in the configuration.

1. **Prerequisites** <br>
     You need `Node.js` and `npm` installed on your target voice server.

3. **Installation** <br>
  Clone this repository and install dependencies:
  ```bash
    git clone https://github.com/oldcordapp/MediaProxyAgent
    cd MediaProxyAgent
    npm install
  ```

3. **Run the agent** <br>
    Start the agent on your target server, passing the Signaling Server URL and the public IP exposure flag.
    Argument | Summary | Example
    --- | --- | --- |
    [CONNECTION_URL] | The websocket URL for your Oldcord MR Signaling Server. | ws://localhost:8080/
    [PUBLIC_IP_FLAG] | Set to true to use the server's public IP address (Recommended for production) or false to use a local IP address | true
    
    Example usage: `node server.js ws://localhost:8080/ true`

4. **Profit** <br>
    The agent will connect, exchange connection information for future clients, wait for instructions from the Signaling Server to manage voice rooms and manage the actual webrtc voice traffic by itself. <br>
    Now go join some voice calls (Provided you're using 2017 or 2018 client builds and Chromium) and have fun!

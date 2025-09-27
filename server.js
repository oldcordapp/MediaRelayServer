const ws = require('ws');
const MediasoupSignalingDelegate = require('./webrtc/MediasoupSignalingDelegate');
const WebSocket = new ws.WebSocket('ws://localhost:4444');
const os = require('os');
const minPort = 5000;
const maxPort = 6000;
const mediaserver = new MediasoupSignalingDelegate();

const SPEAKING_THROTTLE_MS = 150; 

let ip_address;
let users = new Map();

global.MEDIA_CODECS = [
    {
        kind: 'audio',
        mimeType: 'audio/opus',
        clockRate: 48000,
        channels: 2,
        parameters: {
            'minptime': 10,
            'useinbandfec': 1,
            'usedtx': 1
        },
        preferredPayloadType: 111,
    },
    {
        kind: 'video',
        mimeType: 'video/VP8',
        clockRate: 90000,
        rtcpFeedback: [
            { type: 'ccm', parameter: 'fir' },
            { type: 'nack' },
            { type: 'nack', parameter: 'pli' },
            { type: 'goog-remb' }
        ],
        preferredPayloadType: 101
    }
];

global.onClientJoinedRoom = async (_client) => {
    if (!_client.webrtcConnected || !_client.voiceRoomId || !_client.room) return;

    let clients = new Set(_client.room._clients.values());
    let video_batch = {};

    await Promise.all(
        Array.from(clients).map(async (client) => {
            if (client.user_id === _client.user_id) return;

            let needsUpdate = false;
            let consumerAudioSsrc = 0;
            let consumerVideoSsrc = 0;
            let consumerRtxSsrc = 0;

            if (client.isProducingAudio() && !_client.isSubscribedToTrack(client.user_id, "audio")) {
                await _client.subscribeToTrack(client.user_id, "audio");
                needsUpdate = true;
            }

            if (client.isProducingVideo() && !_client.isSubscribedToTrack(client.user_id, "video")) {
                await _client.subscribeToTrack(client.user_id, "video");
                needsUpdate = true;
            }

            if (!needsUpdate) return;

            const audioConsumer = _client.consumers.find(
                (consumer) => consumer.producerId === client.audioProducer?.id
            );

            const videoConsumer = _client.consumers.find(
                (consumer) => consumer.producerId === client.videoProducer?.id
            );

            if (audioConsumer) {
                consumerAudioSsrc = audioConsumer.rtpParameters?.encodings?.[0]?.ssrc ?? 0;
            }

            if (videoConsumer) {
                consumerVideoSsrc = videoConsumer.rtpParameters?.encodings?.[0]?.ssrc ?? 0;
                consumerRtxSsrc = videoConsumer.rtpParameters?.encodings?.[0]?.rtx?.ssrc ?? 0;
            }

            video_batch[_client.user_id] = {
                op: 12,
                d: {
                    user_id: client.user_id,
                    audio_ssrc: consumerAudioSsrc,
                    video_ssrc: consumerVideoSsrc,
                    rtx_ssrc: consumerRtxSsrc
                },
            };
        }),
    );

    if (Object.entries(video_batch).length > 0) {
        WebSocket.send(JSON.stringify({
            op: "VIDEO_BATCH",
            d: video_batch
        }));
    }
};

function getIPAddress() {
    var interfaces = os.networkInterfaces();
    for (var devName in interfaces) {
        var iface = interfaces[devName];

        for (var i = 0; i < iface.length; i++) {
            var alias = iface[i];

            if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal)
                return alias.address;
        }
    }
    return '0.0.0.0';
}

WebSocket.on('open', async () => {
    console.log(`[MEDIA RELAY CLIENT] Connected to central server!`);

    let ip_address = getIPAddress();
    //let try_get_ip = await fetch("https://checkip.amazonaws.com");

    //ip_address = await try_get_ip.text();

    await mediaserver.start(ip_address, minPort, maxPort, true);


    WebSocket.send(JSON.stringify({
        op: "IDENTIFY",
        d: {
            public_ip: ip_address,
            public_port: mediaserver.port,
            timestamp: Date.now()
        }
    }));
});

WebSocket.on('message', async (data) => {
    let json = JSON.parse(Buffer.from(data).toString('utf-8'));

    console.log(JSON.stringify(json));

    if (json.op === 'ALRIGHT') {
        let location = json.d.location;

        console.log(`[MEDIA RELAY CLIENT] Identified with central server! There are ${location - 1} other server(s) in front of us.`);
    } else if (json.op === 'HEARTBEAT_INFO') {
        let heartbeat_interval = json.d.heartbeat_interval;

        setInterval(() => {
            WebSocket.send(JSON.stringify({
                op: "HEARTBEAT",
                d: Date.now()
            }));
        }, heartbeat_interval);
    } else if (json.op === 'CLIENT_CLOSE') {
        console.log(`[MEDIA RELAY CLIENT] Client closed! Removed from internal store.`);

        users.delete(json.d.user_id);
    } else if (json.op === 'CLIENT_IDENTIFY') {
        let ip_address = json.d.ip_address;
        let user_id = json.d.user_id;
        let ssrc = json.d.ssrc;
        let room_id = json.d.room_id;

        console.log(`[MEDIA RELAY CLIENT] Client (${user_id}) joined room id: ${room_id}`);

        let client = await mediaserver.join(room_id, user_id, WebSocket, 'guild-voice');
        
        client.initIncomingSSRCs({
            audio_ssrc: 0,
            video_ssrc: 0,
            rtx_ssrc: 0
        });

        users.set(user_id, {
            ip_address: ip_address,
            ssrc: ssrc,
            room_id: room_id,
            client: client,
            is_speaking: false,
            last_speaking_update: 0
        });
    } else if (json.op === 'OFFER') {
        let sdp = json.d.sdp;
        let codecs = json.d.codecs;
        let ip_address = json.d.ip_address;
        let user_id = json.d.user_id;
        let room_id = json.d.room_id;
        let client_build = json.d.client_build;
        let client_build_date = new Date(json.d.client_build_date);

        let user = users.get(user_id);

        if (!user)  {
            return;
        }

        let answer = await mediaserver.onOffer(client_build, client_build_date, user.client, sdp, codecs);

        WebSocket.send(JSON.stringify({
            op: "ANSWER",
            d: {
                room_id: room_id,
                user_id: user_id,
                sdp: answer.sdp,
                audio_codec: 'opus',
                video_codec: answer.selectedVideoCodec
            }
        }));

        console.log(`[MEDIA RELAY CLIENT] Answered client (${user_id})`);
    } else if (json.op === 'CLIENT_SPEAKING') {
        let ip_address = json.d.ip_address;
        let user_id = json.d.user_id;
        let room_id = json.d.room_id;
        let speaking = json.d.speaking;
        let audio_ssrc = json.d.audio_ssrc;

        const now = Date.now();

        let user = users.get(user_id);

        if (!user) {
            return;
        }

        if (user.is_speaking === speaking && (now - user.last_speaking_update) < SPEAKING_THROTTLE_MS) {
            return;
        }

        user.is_speaking = speaking;

        let speaking_batch = {};
        let video_batch = {};
        let producerClient = user.client;

        if (!producerClient.isProducingAudio()) {
            console.log(`[MEDIA RELAY CLIENT] Client ${user_id} sent a speaking packet but has no audio producer.`);
            return;
        }

        let incomingSSRCs = producerClient.getIncomingStreamSSRCs();

        if (incomingSSRCs.audio_ssrc !== audio_ssrc) {
            console.log(`[MEDIA RELAY CLIENT] [${user_id}] SSRC mismatch detected. Correcting audio SSRC from ${incomingSSRCs.audio_ssrc} to ${audio_ssrc}.`);

            producerClient.stopPublishingTrack("audio");

            producerClient.initIncomingSSRCs({
                audio_ssrc: audio_ssrc,
                video_ssrc: incomingSSRCs.video_ssrc,
                rtx_ssrc: incomingSSRCs.rtx_ssrc
            });

            await producerClient.publishTrack("audio", { audio_ssrc: audio_ssrc });

            const clientsToNotify = new Set();

            for (const otherClient of producerClient.room.clients.values()) {
                if (otherClient.user_id === user_id) continue;

                await otherClient.subscribeToTrack(user_id, "audio");

                clientsToNotify.add(otherClient);
            }

            await Promise.all(
                Array.from(clientsToNotify).map((client) => {
                    const updatedSsrcs = client.getOutgoingStreamSSRCsForUser(user_id);

                    video_batch[client.user_id] = {
                        op: 12,
                        d: {
                            user_id: user_id,
                            audio_ssrc: updatedSsrcs.audio_ssrc,
                            video_ssrc: updatedSsrcs.video_ssrc,
                            rtx_ssrc: updatedSsrcs.rtx_ssrc
                        }
                    }
                }),
            );
        }

        await Promise.all(
            Array.from(
                mediaserver.getClientsForRtcServer(
                    room_id,
                ),
            ).map((client) => {
                if (client.user_id === user_id) return Promise.resolve();

                const ssrcInfo = client.getOutgoingStreamSSRCsForUser(user_id);

                if (speaking && ssrcInfo.audio_ssrc === 0) {
                    console.log(`[MEDIA RELAY CLIENT] Suppressing speaking packet for ${client.user_id} as consumer for ${user_id} is not ready (ssrc=0).`);
                    return Promise.resolve();
                }

                speaking_batch[client.user_id] = {
                    op: 5,
                    d: {
                        user_id: user_id,
                        speaking: speaking,
                        ssrc: ssrcInfo.audio_ssrc
                    }
                }
            }),
        );

        if (Object.entries(video_batch).length > 0) {
            WebSocket.send(JSON.stringify({
                op: "VIDEO_BATCH",
                d: video_batch
            }));
        }

        WebSocket.send(JSON.stringify({
            op: "SPEAKING_BATCH",
            d: speaking_batch
        }));
    } else if (json.op === 'VIDEO') {
        let user_id = json.d.user_id;
        let d = json.d;

        let user = users.get(user_id);

        if (!user) {
            return;
        }

        let producerClient = user.client;

        const video_batch = {};
        const clientsThatNeedUpdate = new Set();
        const wantsToProduceAudio = d.audio_ssrc !== 0;
        const wantsToProduceVideo = d.video_ssrc !== 0;

        const isCurrentlyProducingAudio = producerClient.isProducingAudio();
        const isCurrentlyProducingVideo = producerClient.isProducingVideo();

        producerClient.initIncomingSSRCs({
            audio_ssrc: d.audio_ssrc,
            video_ssrc: d.video_ssrc,
            rtx_ssrc: d.rtx_ssrc
        });

        if (wantsToProduceAudio && !isCurrentlyProducingAudio) {
            console.log(`[MEDIA RELAY CLIENT] [${user_id}] Starting audio production with ssrc ${d.audio_ssrc}`);
            await producerClient.publishTrack("audio", { audio_ssrc: d.audio_ssrc });

            for (const client of producerClient.room.clients.values()) {
                if (client.user_id === user_id) continue;
                await client.subscribeToTrack(user_id, "audio");
                clientsThatNeedUpdate.add(client);
            }
        }
        else if (!wantsToProduceAudio && isCurrentlyProducingAudio) {
            console.log(`[MEDIA RELAY CLIENT] [${user_id}] Stopping audio production.`);
            producerClient.stopPublishingTrack("audio");

            for (const client of producerClient.room.clients.values()) {
                if (client.user_id !== user_id) clientsThatNeedUpdate.add(client);
            }
        }

        if (wantsToProduceVideo && !isCurrentlyProducingVideo) {
            console.log(`[MEDIA RELAY CLIENT] [${user_id}] Starting video production with ssrc ${d.video_ssrc}`);
            await producerClient.publishTrack("video", { video_ssrc: d.video_ssrc, rtx_ssrc: d.rtx_ssrc });

            for (const client of producerClient.room.clients.values()) {
                if (client.user_id === user_id) continue;
                await client.subscribeToTrack(user_id, "video");
                clientsThatNeedUpdate.add(client);
            }
        }
        else if (!wantsToProduceVideo && isCurrentlyProducingVideo) {
            console.log(`[MEDIA RELAY CLIENT] [${user_id}] Stopping video production.`);
            producerClient.stopPublishingTrack("video");

            for (const client of producerClient.room.clients.values()) {
                if (client.user_id !== user_id) clientsThatNeedUpdate.add(client);
            }
        }

        await Promise.all(
            Array.from(clientsThatNeedUpdate).map((client) => {
                const ssrcs = client.getOutgoingStreamSSRCsForUser(user_id);

                video_batch[client.user_id] = {
                    op: 12,
                    d: {
                        user_id: user_id,
                        audio_ssrc: ssrcs.audio_ssrc,
                        video_ssrc: ssrcs.video_ssrc,
                        rtx_ssrc: ssrcs.rtx_ssrc
                    },
                };
            }),
        );

        if (Object.entries(video_batch).length > 0) {
            WebSocket.send(JSON.stringify({
                op: "VIDEO_BATCH",
                d: video_batch
            }));
        }
    }
});
#!/usr/bin/env node
// Generate a VAPID key pair for Web Push. Put the PUBLIC key in config/push.json and the PRIVATE key
// in the GitHub secret VAPID_PRIVATE_KEY. Never commit the private key.
import webpush from 'web-push';
const k = webpush.generateVAPIDKeys();
console.log(JSON.stringify({ publicKey: k.publicKey, privateKey: k.privateKey }, null, 2));

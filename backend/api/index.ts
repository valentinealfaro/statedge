// Vercel serverless entry point.
// Vercel auto-discovers files under api/ and turns them into Functions.
import 'dotenv/config';
import { createApp } from '../src/app.js';

export default createApp();

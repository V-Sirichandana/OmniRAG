import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';

const JWT_SECRET = process.env.JWT_SECRET || 'omnirag-enterprise-secret-key-32chars';
const ALLOW_ORG_SIGNUP = process.env.ALLOW_ORG_SIGNUP !== 'false';
const MIN_RERANK_SCORE = parseFloat(process.env.MIN_RERANK_SCORE || '0.05');

app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));
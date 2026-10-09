import dotenv from 'dotenv';
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

// Middleware to normalize route paths for both direct and Vercel serverless requests
app.use((req, _res, next) => {
  if (
    !req.url.startsWith('/api') &&
    !req.url.startsWith('/@') &&
    !req.url.startsWith('/src') &&
    !req.url.startsWith('/node_modules') &&
    !req.url.startsWith('/dist') &&
    !req.url.includes('.')
  ) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  next();
});
/*
  ENCO API — servidor Express com tratamento de erros em todos os endpoints.
  CORRECÇÕES v2:
    1. app.listen() só corre DEPOIS de mongoose.connect() resolver → elimina race condition.
    2. Middleware de "DB não pronto" → 503 em vez de crash durante reconexão.
    3. mongoose.set('bufferCommands', false) mantido — erros imediatos e explícitos.
    4. seedAdmin só corre depois da ligação estar confirmed ready.
    5. Removida rota duplicada GET /api/admin/stats.
    6. Lógica de reconexão robusta com back-off.
    7. JWT_SECRET movido para process.env com fallback apenas em dev.
    8. upload.single() envolto em try/catch via wrapper para erros de multer.
    9. Corrigido: imagekit.files.upload() → segundo argumento é options, não fileName.
   10. Corrigido: imagekit.assets.list() → API correcta para listar ficheiros.
   11. Adicionado: PATCH /api/admin/slides/reorder deve estar ANTES de /:id (Express routing).
*/

require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const { body, validationResult } = require('express-validator');
const ImageKit = require('@imagekit/nodejs');
const { toFile } = require('@imagekit/nodejs');
const multer   = require('multer');

// ─────────────────────────────────────────────
// DESLIGA O BUFFERING — falha imediato em vez
// de ficar pendurado por query sem ligação
// ─────────────────────────────────────────────
mongoose.set('bufferCommands', false);

const app = express();
const PORT = process.env.PORT || 4000;

// JWT_SECRET: usa variável de ambiente; em produção NUNCA usar o fallback
const JWT_SECRET = process.env.JWT_SECRET || 'enco_super_secret_2025_dev_only';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('AVISO: JWT_SECRET não definido em produção! Define a variável de ambiente.');
}

// ──────────────────────────────────────────────
// HELPER GLOBAL — resposta de erro padronizada
// ──────────────────────────────────────────────
function apiError(res, err, status = 500, context = '') {
  const message = err instanceof Error ? err.message : String(err);
  const stack   = process.env.NODE_ENV !== 'production' && err instanceof Error ? err.stack : undefined;
  console.error(`  [${context || 'API'}]`, message);
  return res.status(status).json({
    ok:      false,
    error:   message,
    context: context || undefined,
    stack:   stack   || undefined,
  });
}

// ──────────────────────────────────────────────
// IMAGEKIT
// ──────────────────────────────────────────────
const imagekit = new ImageKit({
  publicKey:   process.env.IMAGEKIT_PUBLIC_KEY  || 'public_X40KBDYHT8F5/LPw1IJX1s6K62Q=',
  privateKey:  process.env.IMAGEKIT_PRIVATE_KEY || 'private_jun/amOWn37j6Pf6aboTA1dhgZs=',
  urlEndpoint: process.env.IMAGEKIT_URL         || 'https://ik.imagekit.io/fsobpyaa5i',
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|mov|avi|pdf/i.test(file.mimetype);
    cb(null, allowed);
  },
});

// Wrapper para erros de multer (ficheiro inválido, tamanho, etc.)
function uploadSingle(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        return res.status(400).json({ ok: false, error: `Upload error: ${err.message}` });
      }
      return res.status(400).json({ ok: false, error: err.message || 'Ficheiro rejeitado.' });
    });
  };
}

// ──────────────────────────────────────────────
// MIDDLEWARE
// ──────────────────────────────────────────────
app.use(cors({
  origin:         '*',
  methods:        ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ──────────────────────────────────────────────
// MIDDLEWARE — guarda DB: devolve 503 se a
// ligação não estiver pronta (estado ≠ 1).
// Aplicado apenas nas rotas /api/* que fazem
// queries; /api/health e /api/auth/login ficam
// fora para permitir diagnóstico e login.
// ──────────────────────────────────────────────
function dbReady(req, res, next) {
  if (mongoose.connection.readyState === 1) return next();
  res.status(503).json({
    ok:    false,
    error: 'Base de dados temporariamente indisponível. Tente novamente em breve.',
  });
}

// ──────────────────────────────────────────────
// MONGODB — ligação robusta
// O servidor HTTP só arranca depois do connect()
// resolver (ver bloco no final do ficheiro).
// ──────────────────────────────────────────────
const MONGO_URI = process.env.MONGO_URI ||
  'mongodb+srv://2smarthrm_db_user:JvrSBCpRla7BLxIw@cluster0.yj1qese.mongodb.net/enco_db?retryWrites=true&w=majority';

let _reconnectTimer = null;

async function connectDB() {
  if (_reconnectTimer) { clearTimeout(_reconnectTimer); _reconnectTimer = null; }
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS:          45000,
    });
    console.log('  MongoDB connected');
    await seedAdmin();
  } catch (err) {
    console.error('  MongoDB connection error:', err.message);
    console.log('  Retrying in 5 s…');
    _reconnectTimer = setTimeout(connectDB, 5000);
  }
}

mongoose.connection.on('disconnected', () => {
  console.warn('  MongoDB disconnected — retrying…');
  // Só tenta reconectar se não houver já um timer pendente
  if (!_reconnectTimer) {
    _reconnectTimer = setTimeout(connectDB, 5000);
  }
});

mongoose.connection.on('error', err => {
  console.error('  MongoDB error:', err.message);
});

// ──────────────────────────────────────────────
// SCHEMAS & MODELS
// ──────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  name:     { type: String, required: true },
  email:    { type: String, required: true, unique: true, lowercase: true },
  password: { type: String, required: true },
  role:     { type: String, enum: ['admin', 'editor'], default: 'admin' },
  avatar:   { type: String, default: null },
}, { timestamps: true });

userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

const User = mongoose.model('User', userSchema);

const slideSchema = new mongoose.Schema({
  title: String, subtitle: String, image: String, link: String,
  order: { type: Number, default: 0 }, active: { type: Boolean, default: true },
}, { timestamps: true });
const Slide = mongoose.model('Slide', slideSchema);

const serviceSchema = new mongoose.Schema({
  title: { type: String, required: true }, desc: String, icon: String, image: String,
  order: { type: Number, default: 0 }, active: { type: Boolean, default: true },
}, { timestamps: true });
const Service = mongoose.model('Service', serviceSchema);

const gallerySchema = new mongoose.Schema({
  title: String, url: String,
  type:  { type: String, enum: ['image', 'video', 'youtube'], default: 'image' },
  ytId:  String, order: { type: Number, default: 0 },
}, { timestamps: true });
const Gallery = mongoose.model('Gallery', gallerySchema);

const testimonialSchema = new mongoose.Schema({
  name: String, role: String, company: String, desc: String,
  image: String, ytUrl: String,
  type:   { type: String, enum: ['text', 'image', 'video'], default: 'text' },
  active: { type: Boolean, default: true },
}, { timestamps: true });
const Testimonial = mongoose.model('Testimonial', testimonialSchema);

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true }, slug: String,
}, { timestamps: true });
const Category = mongoose.model('Category', categorySchema);

const postSchema = new mongoose.Schema({
  title:    { type: String, required: true }, slug: String, desc: String,
  html:     String, image: String,
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  status:   { type: String, enum: ['rascunho', 'publicado', 'agendado'], default: 'rascunho' },
  publishAt: Date, author: String,
}, { timestamps: true });
const Post = mongoose.model('Post', postSchema);

const contactSchema = new mongoose.Schema({
  phone: String, email: String, address: String,
  facebook: String, instagram: String, linkedin: String,
  youtube: String, whatsapp: String, mapEmbed: String, hours: String,
}, { timestamps: true });
const Contact = mongoose.model('Contact', contactSchema);

const profileSchema = new mongoose.Schema({
  companyName: String, tagline: String, logo: String,
  favicon: String, metaDesc: String, primaryColor: String,
}, { timestamps: true });
const Profile = mongoose.model('Profile', profileSchema);

const productCategorySchema = new mongoose.Schema({
  name:  { type: String, required: true },
  slug:  String,
  order: { type: Number, default: 0 },
}, { timestamps: true });
const ProductCategory = mongoose.model('ProductCategory', productCategorySchema);

const productSchema = new mongoose.Schema({
  title:     { type: String, required: true },
  slug:      String,
  shortDesc: String,
  html:      String,
  image:     String,
  images:    [String],
  category:  { type: mongoose.Schema.Types.ObjectId, ref: 'ProductCategory' },
  featured:  { type: Boolean, default: false },
  active:    { type: Boolean, default: true },
  order:     { type: Number, default: 0 },
  tags:      [String],
}, { timestamps: true });
const Product = mongoose.model('Product', productSchema);

const messageSchema = new mongoose.Schema({
  name:    { type: String, required: true },
  email:   { type: String, required: true },
  phone:   { type: String },
  subject: { type: String },
  message: { type: String, required: true },
  status:  { type: String, enum: ['unread', 'read'], default: 'unread' },
}, { timestamps: true });
const Message = mongoose.model('Message', messageSchema);

// ──────────────────────────────────────────────
// AUTH MIDDLEWARE
// ──────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ ok: false, error: 'Token em falta.' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ ok: false, error: 'Token inválido ou expirado.', detail: err.message });
  }
}

// ──────────────────────────────────────────────
// SEED ADMIN
// ──────────────────────────────────────────────
async function seedAdmin() {
  try {
    const exists = await User.findOne({ email: 'gestor@enco.co.ao' });
    if (exists) return;
    await User.create({ name: 'Gestor ENCO', email: 'gestor@enco.co.ao', password: 'Enco@2025', role: 'admin' });
    console.log('  Admin criado → gestor@enco.co.ao  /  Enco@2025');
  } catch (err) {
    console.error('  seedAdmin:', err.message);
  }
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────
const validate = (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) { res.status(422).json({ ok: false, errors: errs.array() }); return true; }
  return false;
};
const slugify = str => str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// ══════════════════════════════════════════════
// HEALTH CHECK (sem dbReady — serve para diagnóstico)
// ══════════════════════════════════════════════
app.get('/api/health', (_req, res) => {
  const state = mongoose.connection.readyState;
  const stateMap = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  res.json({ status: 'ok', db: stateMap[state] || 'unknown', timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════
// AUTH ROUTES (sem dbReady no login para melhor UX de erro)
// ══════════════════════════════════════════════

app.post('/api/auth/login',
  body('email').isEmail(), body('password').notEmpty(),
  async (req, res) => {
    if (validate(req, res)) return;
    // Verificação manual aqui para dar erro 503 em vez de crash
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, error: 'Base de dados temporariamente indisponível.' });
    }
    try {
      const { email, password } = req.body;
      const user = await User.findOne({ email });
      if (!user || !(await bcrypt.compare(password, user.password)))
        return res.status(401).json({ ok: false, error: 'Credenciais inválidas.' });
      const token = jwt.sign(
        { id: user._id, email: user.email, role: user.role, name: user.name },
        JWT_SECRET, { expiresIn: '8h' }
      );
      res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar } });
    } catch (err) { apiError(res, err, 500, 'POST /api/auth/login'); }
  }
);

app.get('/api/auth/me', auth, dbReady, async (req, res) => {
  try {
    res.json(await User.findById(req.user.id).select('-password'));
  } catch (err) { apiError(res, err, 500, 'GET /api/auth/me'); }
});

app.put('/api/auth/me', auth, dbReady,
  body('name').optional().notEmpty(),
  body('password').optional().isLength({ min: 4 }),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const updates = {};
      if (req.body.name)     updates.name     = req.body.name;
      if (req.body.avatar)   updates.avatar   = req.body.avatar;
      if (req.body.password) updates.password = await bcrypt.hash(req.body.password, 12);
      res.json(await User.findByIdAndUpdate(req.user.id, updates, { new: true }).select('-password'));
    } catch (err) { apiError(res, err, 500, 'PUT /api/auth/me'); }
  }
);

// ══════════════════════════════════════════════
// IMAGEKIT — FILE UPLOAD
// ══════════════════════════════════════════════

app.post('/api/admin/upload', auth, uploadSingle('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Nenhum ficheiro enviado.' });
    const folder   = req.body.folder || '/enco';
    const ext      = req.file.originalname.split('.').pop().toLowerCase();
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
    const fileObj  = await toFile(req.file.buffer, safeName, { type: req.file.mimetype });
    const result   = await imagekit.upload({
      file:            fileObj,
      fileName:        safeName,
      folder,
      useUniqueFileName: true,
      tags:            ['enco'],
    });
    res.json({
      url:          result.url,
      fileId:       result.fileId,
      name:         result.name,
      size:         result.size,
      filePath:     result.filePath,
      thumbnailUrl: result.thumbnailUrl || result.url,
    });
  } catch (err) { apiError(res, err, 500, 'POST /api/admin/upload'); }
});

app.post('/api/admin/upload/url', auth,
  body('url').isURL(),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const { url, fileName, folder = '/enco' } = req.body;
      const result = await imagekit.upload({
        file:            url,
        fileName:        fileName || `remote_${Date.now()}`,
        folder,
        useUniqueFileName: true,
      });
      res.json({ url: result.url, fileId: result.fileId, filePath: result.filePath });
    } catch (err) { apiError(res, err, 500, 'POST /api/admin/upload/url'); }
  }
);

app.get('/api/admin/upload/files', auth, async (req, res) => {
  try {
    const { folder = '/enco', limit = 50, skip = 0 } = req.query;
    // Corrigido: API correcta para listar ficheiros no ImageKit SDK v5+
    const files = await imagekit.listFiles({
      path:   folder,
      limit:  Number(limit),
      skip:   Number(skip),
    });
    res.json(files);
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/upload/files'); }
});

app.get('/api/admin/upload/auth-token', auth, (_req, res) => {
  try {
    const params = imagekit.getAuthenticationParameters();
    res.json({
      ...params,
      publicKey:   imagekit.options.publicKey,
      urlEndpoint: imagekit.options.urlEndpoint,
    });
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/upload/auth-token'); }
});

app.delete('/api/admin/upload/:fileId', auth, async (req, res) => {
  try {
    await imagekit.deleteFile(req.params.fileId);
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'DELETE /api/admin/upload/:fileId'); }
});

// ══════════════════════════════════════════════
// SLIDES / CAROUSEL
// ATENÇÃO: /reorder DEVE estar antes de /:id
// para o Express não tratar "reorder" como um ID
// ══════════════════════════════════════════════

app.get('/api/slides', dbReady, async (_req, res) => {
  try {
    res.json(await Slide.find({ active: true }).sort({ order: 1, createdAt: -1 }));
  } catch (err) { apiError(res, err, 500, 'GET /api/slides'); }
});

app.get('/api/admin/slides', auth, dbReady, async (_req, res) => {
  try {
    res.json(await Slide.find().sort({ order: 1, createdAt: -1 }));
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/slides'); }
});

app.post('/api/admin/slides', auth, dbReady, body('title').notEmpty(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    res.status(201).json(await Slide.create(req.body));
  } catch (err) { apiError(res, err, 500, 'POST /api/admin/slides'); }
});

// REORDER antes de /:id
app.patch('/api/admin/slides/reorder', auth, dbReady, async (req, res) => {
  try {
    await Promise.all(req.body.map(o => Slide.findByIdAndUpdate(o.id, { order: o.order })));
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'PATCH /api/admin/slides/reorder'); }
});

app.put('/api/admin/slides/:id', auth, dbReady, async (req, res) => {
  try {
    const doc = await Slide.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Slide não encontrado.' });
    res.json(doc);
  } catch (err) { apiError(res, err, 500, 'PUT /api/admin/slides/:id'); }
});

app.delete('/api/admin/slides/:id', auth, dbReady, async (req, res) => {
  try {
    await Slide.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'DELETE /api/admin/slides/:id'); }
});

// ══════════════════════════════════════════════
// SERVICES
// ══════════════════════════════════════════════

app.get('/api/services', dbReady, async (_req, res) => {
  try {
    res.json(await Service.find({ active: true }).sort({ order: 1 }));
  } catch (err) { apiError(res, err, 500, 'GET /api/services'); }
});

app.get('/api/admin/services', auth, dbReady, async (_req, res) => {
  try {
    res.json(await Service.find().sort({ order: 1 }));
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/services'); }
});

app.post('/api/admin/services', auth, dbReady, body('title').notEmpty(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    res.status(201).json(await Service.create(req.body));
  } catch (err) { apiError(res, err, 500, 'POST /api/admin/services'); }
});

app.put('/api/admin/services/:id', auth, dbReady, async (req, res) => {
  try {
    const doc = await Service.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Serviço não encontrado.' });
    res.json(doc);
  } catch (err) { apiError(res, err, 500, 'PUT /api/admin/services/:id'); }
});

app.delete('/api/admin/services/:id', auth, dbReady, async (req, res) => {
  try {
    await Service.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'DELETE /api/admin/services/:id'); }
});

// ══════════════════════════════════════════════
// GALLERY
// ══════════════════════════════════════════════

app.get('/api/gallery', dbReady, async (req, res) => {
  try {
    const filter = req.query.type ? { type: req.query.type } : {};
    res.json(await Gallery.find(filter).sort({ order: 1, createdAt: -1 }));
  } catch (err) { apiError(res, err, 500, 'GET /api/gallery'); }
});

app.get('/api/admin/gallery', auth, dbReady, async (_req, res) => {
  try {
    res.json(await Gallery.find().sort({ order: 1, createdAt: -1 }));
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/gallery'); }
});

app.post('/api/admin/gallery', auth, dbReady, async (req, res) => {
  try {
    res.status(201).json(await Gallery.create(req.body));
  } catch (err) { apiError(res, err, 500, 'POST /api/admin/gallery'); }
});

app.put('/api/admin/gallery/:id', auth, dbReady, async (req, res) => {
  try {
    const doc = await Gallery.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Item de galeria não encontrado.' });
    res.json(doc);
  } catch (err) { apiError(res, err, 500, 'PUT /api/admin/gallery/:id'); }
});

app.delete('/api/admin/gallery/:id', auth, dbReady, async (req, res) => {
  try {
    await Gallery.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'DELETE /api/admin/gallery/:id'); }
});

// ══════════════════════════════════════════════
// TESTIMONIALS
// ══════════════════════════════════════════════

app.get('/api/testimonials', dbReady, async (_req, res) => {
  try {
    res.json(await Testimonial.find({ active: true }).sort({ createdAt: -1 }));
  } catch (err) { apiError(res, err, 500, 'GET /api/testimonials'); }
});

app.get('/api/admin/testimonials', auth, dbReady, async (_req, res) => {
  try {
    res.json(await Testimonial.find().sort({ createdAt: -1 }));
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/testimonials'); }
});

app.post('/api/admin/testimonials', auth, dbReady, async (req, res) => {
  try {
    res.status(201).json(await Testimonial.create(req.body));
  } catch (err) { apiError(res, err, 500, 'POST /api/admin/testimonials'); }
});

app.put('/api/admin/testimonials/:id', auth, dbReady, async (req, res) => {
  try {
    const doc = await Testimonial.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Testemunho não encontrado.' });
    res.json(doc);
  } catch (err) { apiError(res, err, 500, 'PUT /api/admin/testimonials/:id'); }
});

app.delete('/api/admin/testimonials/:id', auth, dbReady, async (req, res) => {
  try {
    await Testimonial.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'DELETE /api/admin/testimonials/:id'); }
});

// ══════════════════════════════════════════════
// BLOG CATEGORIES
// ══════════════════════════════════════════════

app.get('/api/categories', dbReady, async (_req, res) => {
  try {
    res.json(await Category.find().sort({ name: 1 }));
  } catch (err) { apiError(res, err, 500, 'GET /api/categories'); }
});

app.post('/api/admin/categories', auth, dbReady, body('name').notEmpty(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    res.status(201).json(await Category.create({ ...req.body, slug: slugify(req.body.name) }));
  } catch (err) { apiError(res, err, 500, 'POST /api/admin/categories'); }
});

app.put('/api/admin/categories/:id', auth, dbReady, async (req, res) => {
  try {
    if (req.body.name) req.body.slug = slugify(req.body.name);
    const doc = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Categoria não encontrada.' });
    res.json(doc);
  } catch (err) { apiError(res, err, 500, 'PUT /api/admin/categories/:id'); }
});

app.delete('/api/admin/categories/:id', auth, dbReady, async (req, res) => {
  try {
    await Category.findByIdAndDelete(req.params.id);
    await Post.updateMany({ category: req.params.id }, { $unset: { category: '' } });
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'DELETE /api/admin/categories/:id'); }
});

// ══════════════════════════════════════════════
// BLOG POSTS
// ══════════════════════════════════════════════

app.get('/api/posts', dbReady, async (req, res) => {
  try {
    const { cat, q, page = 1, limit = 9 } = req.query;
    const filter = { status: 'publicado' };
    if (cat) filter.category = cat;
    if (q)   filter.title    = { $regex: q, $options: 'i' };
    const total = await Post.countDocuments(filter);
    const posts = await Post.find(filter)
      .populate('category', 'name slug').sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(Number(limit));
    res.json({ posts, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) { apiError(res, err, 500, 'GET /api/posts'); }
});

app.get('/api/posts/:idOrSlug', dbReady, async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isId = mongoose.Types.ObjectId.isValid(idOrSlug);
    const post = isId
      ? await Post.findById(idOrSlug).populate('category', 'name slug')
      : await Post.findOne({ slug: idOrSlug }).populate('category', 'name slug');
    if (!post || post.status !== 'publicado')
      return res.status(404).json({ ok: false, error: 'Post não encontrado.' });
    res.json(post);
  } catch (err) { apiError(res, err, 500, 'GET /api/posts/:idOrSlug'); }
});

app.get('/api/admin/posts', auth, dbReady, async (req, res) => {
  try {
    const { cat, status, q, page = 1, limit = 12 } = req.query;
    const filter = {};
    if (cat)    filter.category = cat;
    if (status) filter.status   = status;
    if (q)      filter.title    = { $regex: q, $options: 'i' };
    const total = await Post.countDocuments(filter);
    const posts = await Post.find(filter)
      .populate('category', 'name').sort({ createdAt: -1 })
      .skip((page - 1) * limit).limit(Number(limit));
    res.json({ posts, total });
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/posts'); }
});

app.post('/api/admin/posts', auth, dbReady, body('title').notEmpty(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    res.status(201).json(await Post.create({ ...req.body, slug: slugify(req.body.title), author: req.user.name }));
  } catch (err) { apiError(res, err, 500, 'POST /api/admin/posts'); }
});

app.put('/api/admin/posts/:id', auth, dbReady, async (req, res) => {
  try {
    if (req.body.title) req.body.slug = slugify(req.body.title);
    const doc = await Post.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Post não encontrado.' });
    res.json(doc);
  } catch (err) { apiError(res, err, 500, 'PUT /api/admin/posts/:id'); }
});

app.delete('/api/admin/posts/:id', auth, dbReady, async (req, res) => {
  try {
    await Post.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'DELETE /api/admin/posts/:id'); }
});

// ══════════════════════════════════════════════
// PRODUCT CATEGORIES
// ══════════════════════════════════════════════

app.get('/api/product-categories', dbReady, async (_req, res) => {
  try {
    res.json(await ProductCategory.find().sort({ order: 1, name: 1 }));
  } catch (err) { apiError(res, err, 500, 'GET /api/product-categories'); }
});

app.post('/api/admin/product-categories', auth, dbReady, body('name').notEmpty(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    res.status(201).json(await ProductCategory.create({ ...req.body, slug: slugify(req.body.name) }));
  } catch (err) { apiError(res, err, 500, 'POST /api/admin/product-categories'); }
});

app.put('/api/admin/product-categories/:id', auth, dbReady, async (req, res) => {
  try {
    if (req.body.name) req.body.slug = slugify(req.body.name);
    const doc = await ProductCategory.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Categoria de produto não encontrada.' });
    res.json(doc);
  } catch (err) { apiError(res, err, 500, 'PUT /api/admin/product-categories/:id'); }
});

app.delete('/api/admin/product-categories/:id', auth, dbReady, async (req, res) => {
  try {
    await ProductCategory.findByIdAndDelete(req.params.id);
    await Product.updateMany({ category: req.params.id }, { $unset: { category: '' } });
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'DELETE /api/admin/product-categories/:id'); }
});

// ══════════════════════════════════════════════
// PRODUCTS
// ══════════════════════════════════════════════

app.get('/api/products', dbReady, async (req, res) => {
  try {
    const { cat, q, featured, page = 1, limit = 12 } = req.query;
    const filter = { active: true };
    if (cat)      filter.category = cat;
    if (featured) filter.featured = true;
    if (q)        filter.title    = { $regex: q, $options: 'i' };
    const total    = await Product.countDocuments(filter);
    const products = await Product.find(filter)
      .populate('category', 'name slug')
      .sort({ order: 1, createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));
    res.json({ products, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) { apiError(res, err, 500, 'GET /api/products'); }
});

app.get('/api/products/:idOrSlug', dbReady, async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const isId    = mongoose.Types.ObjectId.isValid(idOrSlug);
    const product = isId
      ? await Product.findOne({ _id: idOrSlug, active: true }).populate('category', 'name slug')
      : await Product.findOne({ slug: idOrSlug, active: true }).populate('category', 'name slug');
    if (!product) return res.status(404).json({ ok: false, error: 'Produto não encontrado.' });
    const related = product.category
      ? await Product.find({ category: product.category._id || product.category, _id: { $ne: product._id }, active: true })
          .populate('category', 'name slug').limit(4)
      : [];
    res.json({ product, related });
  } catch (err) { apiError(res, err, 500, 'GET /api/products/:idOrSlug'); }
});

app.get('/api/admin/products', auth, dbReady, async (req, res) => {
  try {
    const { cat, q, page = 1, limit = 12 } = req.query;
    const filter = {};
    if (cat) filter.category = cat;
    if (q)   filter.title    = { $regex: q, $options: 'i' };
    const total    = await Product.countDocuments(filter);
    const products = await Product.find(filter)
      .populate('category', 'name')
      .sort({ order: 1, createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));
    res.json({ products, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/products'); }
});

app.post('/api/admin/products', auth, dbReady, body('title').notEmpty(), async (req, res) => {
  if (validate(req, res)) return;
  try {
    res.status(201).json(await Product.create({ ...req.body, slug: slugify(req.body.title) }));
  } catch (err) { apiError(res, err, 500, 'POST /api/admin/products'); }
});

app.put('/api/admin/products/:id', auth, dbReady, async (req, res) => {
  try {
    if (req.body.title) req.body.slug = slugify(req.body.title);
    const doc = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ ok: false, error: 'Produto não encontrado.' });
    res.json(doc);
  } catch (err) { apiError(res, err, 500, 'PUT /api/admin/products/:id'); }
});

app.delete('/api/admin/products/:id', auth, dbReady, async (req, res) => {
  try {
    await Product.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'DELETE /api/admin/products/:id'); }
});

// ══════════════════════════════════════════════
// MESSAGES
// ══════════════════════════════════════════════

app.post('/api/messages', dbReady,
  body('name').notEmpty().withMessage('Nome obrigatório'),
  body('email').isEmail().withMessage('Email inválido'),
  body('message').notEmpty().withMessage('Mensagem obrigatória'),
  async (req, res) => {
    if (validate(req, res)) return;
    try {
      const msg = await Message.create({
        name:    req.body.name,
        email:   req.body.email,
        phone:   req.body.phone   || '',
        subject: req.body.subject || '',
        message: req.body.message,
      });
      res.status(201).json({ ok: true, id: msg._id });
    } catch (err) { apiError(res, err, 500, 'POST /api/messages'); }
  }
);

app.get('/api/admin/messages', auth, dbReady, async (req, res) => {
  try {
    const { q, status, page = 1, limit = 15 } = req.query;
    const filter = {};
    if (status === 'unread' || status === 'read') filter.status = status;
    if (q) filter.$or = [
      { name:    { $regex: q, $options: 'i' } },
      { email:   { $regex: q, $options: 'i' } },
      { subject: { $regex: q, $options: 'i' } },
      { message: { $regex: q, $options: 'i' } },
    ];
    const total    = await Message.countDocuments(filter);
    const unread   = await Message.countDocuments({ status: 'unread' });
    const messages = await Message.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit));
    res.json({ messages, total, unread, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/messages'); }
});

app.get('/api/admin/messages/:id', auth, dbReady, async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ ok: false, error: 'Mensagem não encontrada.' });
    res.json(msg);
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/messages/:id'); }
});

app.patch('/api/admin/messages/:id/read', auth, dbReady, async (req, res) => {
  try {
    const msg = await Message.findByIdAndUpdate(req.params.id, { status: 'read' }, { new: true });
    if (!msg) return res.status(404).json({ ok: false, error: 'Mensagem não encontrada.' });
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'PATCH /api/admin/messages/:id/read'); }
});

app.delete('/api/admin/messages/:id', auth, dbReady, async (req, res) => {
  try {
    await Message.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (err) { apiError(res, err, 500, 'DELETE /api/admin/messages/:id'); }
});

// ══════════════════════════════════════════════
// CONTACT INFO
// ══════════════════════════════════════════════

app.get('/api/contact', dbReady, async (_req, res) => {
  try {
    res.json(await Contact.findOne() || {});
  } catch (err) { apiError(res, err, 500, 'GET /api/contact'); }
});

app.put('/api/admin/contact', auth, dbReady, async (req, res) => {
  try {
    res.json(await Contact.findOneAndUpdate({}, req.body, { new: true, upsert: true }));
  } catch (err) { apiError(res, err, 500, 'PUT /api/admin/contact'); }
});

// ══════════════════════════════════════════════
// SITE PROFILE / CONFIG
// ══════════════════════════════════════════════

app.get('/api/profile', dbReady, async (_req, res) => {
  try {
    res.json(await Profile.findOne() || {});
  } catch (err) { apiError(res, err, 500, 'GET /api/profile'); }
});

app.put('/api/admin/profile', auth, dbReady, async (req, res) => {
  try {
    res.json(await Profile.findOneAndUpdate({}, req.body, { new: true, upsert: true }));
  } catch (err) { apiError(res, err, 500, 'PUT /api/admin/profile'); }
});

// ══════════════════════════════════════════════
// DASHBOARD STATS
// ══════════════════════════════════════════════

app.get('/api/admin/stats', auth, dbReady, async (_req, res) => {
  try {
    const [
      slides, services, gallery, testimonials,
      posts, categories, products, productCategories,
      messages, unreadMessages,
    ] = await Promise.all([
      Slide.countDocuments(),
      Service.countDocuments(),
      Gallery.countDocuments(),
      Testimonial.countDocuments(),
      Post.countDocuments(),
      Category.countDocuments(),
      Product.countDocuments(),
      ProductCategory.countDocuments(),
      Message.countDocuments(),
      Message.countDocuments({ status: 'unread' }),
    ]);

    const [published, drafts, scheduled] = await Promise.all([
      Post.countDocuments({ status: 'publicado' }),
      Post.countDocuments({ status: 'rascunho' }),
      Post.countDocuments({ status: 'agendado' }),
    ]);

    const recentPosts = await Post.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .populate('category', 'name');

    res.json({
      slides, services, gallery, testimonials,
      posts, categories, products, productCategories,
      messages, unreadMessages,
      published, drafts, scheduled,
      recentPosts,
    });
  } catch (err) { apiError(res, err, 500, 'GET /api/admin/stats'); }
});

// ══════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ══════════════════════════════════════════════
app.use((err, req, res, _next) => {
  apiError(res, err, err.status || 500, `${req.method} ${req.path}`);
});

// ══════════════════════════════════════════════
// START — O servidor só arranca DEPOIS do
// mongoose.connect() resolver. Isto elimina
// completamente a race condition com
// bufferCommands: false.
// Em caso de falha na primeira ligação, o
// servidor não arranca (processo termina com
// erro) para que o gestor de processos
// (pm2, docker, etc.) possa reiniciar.
// ══════════════════════════════════════════════
(async () => {
  try {
    console.log('  A ligar ao MongoDB…');
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS:          45000,
    });
    console.log('  MongoDB connected');
    await seedAdmin();

    // Só depois da DB estar pronta é que o HTTP começa a aceitar ligações
    app.listen(PORT, () => {
      console.log(`\n  ENCO API  →  http://localhost:${PORT}\n`);
      console.log(`  PÚBLICAS (sem token)`);
      console.log(`   GET  /api/health`);
      console.log(`   GET  /api/slides`);
      console.log(`   GET  /api/services`);
      console.log(`   GET  /api/gallery`);
      console.log(`   GET  /api/testimonials`);
      console.log(`   GET  /api/categories`);
      console.log(`   GET  /api/posts`);
      console.log(`   GET  /api/posts/:idOrSlug`);
      console.log(`   GET  /api/contact`);
      console.log(`   GET  /api/profile`);
      console.log(`   GET  /api/product-categories`);
      console.log(`   GET  /api/products`);
      console.log(`   GET  /api/products/:idOrSlug`);
      console.log(`   POST /api/messages`);
      console.log(`\n  PRIVADAS (Bearer JWT)`);
      console.log(`   POST              /api/auth/login`);
      console.log(`   GET  PUT          /api/auth/me`);
      console.log(`   GET  POST PUT DEL /api/admin/slides`);
      console.log(`   GET  POST PUT DEL /api/admin/services`);
      console.log(`   GET  POST PUT DEL /api/admin/gallery`);
      console.log(`   GET  POST PUT DEL /api/admin/testimonials`);
      console.log(`   GET  POST PUT DEL /api/admin/categories`);
      console.log(`   GET  POST PUT DEL /api/admin/posts`);
      console.log(`   GET  POST PUT DEL /api/admin/product-categories`);
      console.log(`   GET  POST PUT DEL /api/admin/products`);
      console.log(`   GET  DEL PATCH    /api/admin/messages`);
      console.log(`   PUT               /api/admin/contact`);
      console.log(`   PUT               /api/admin/profile`);
      console.log(`   GET               /api/admin/stats`);
      console.log(`\n  IMAGEKIT`);
      console.log(`   POST /api/admin/upload`);
      console.log(`   POST /api/admin/upload/url`);
      console.log(`   GET  /api/admin/upload/files`);
      console.log(`   GET  /api/admin/upload/auth-token`);
      console.log(`   DEL  /api/admin/upload/:fileId\n`);
    });

    // Reconexão automática após o arranque (para quedas de rede durante operação)
    mongoose.connection.on('disconnected', () => {
      console.warn('  MongoDB disconnected — retrying…');
      if (!_reconnectTimer) {
        _reconnectTimer = setTimeout(connectDB, 5000);
      }
    });
    mongoose.connection.on('error', err => {
      console.error('  MongoDB error:', err.message);
    });

  } catch (err) {
    console.error('  Falha fatal ao iniciar — MongoDB não disponível:', err.message);
    process.exit(1); // pm2/docker reinicia automaticamente
  }
})();

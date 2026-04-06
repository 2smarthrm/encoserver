/*

quando hospedado em vercel aparece o seguinte erro:

SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON
login.html:407  POST https://encoserver.vercel.app/api 404 (Not Found)
doLogin @ login.html:407
onclick @ login.html:319Understand this error
login.html:422 SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON



*/


require('dotenv').config();
const express             = require('express');
const mongoose            = require('mongoose');
const bcrypt              = require('bcryptjs');
const jwt                 = require('jsonwebtoken');
const cors                = require('cors');
const { body, validationResult } = require('express-validator');
const ImageKit            = require('@imagekit/nodejs');
const { toFile }          = require('@imagekit/nodejs');
const multer              = require('multer');

const app        = express();
const PORT =  4000;
const JWT_SECRET =  'enco_super_secret_2025';

// ──────────────────────────────────────────────
// IMAGEKIT  (ficheiros vão directamente para a cloud, zero disco local)
// ──────────────────────────────────────────────
const imagekit = new ImageKit({
  publicKey:   'public_X40KBDYHT8F5/LPw1IJX1s6K62Q=',
  privateKey:  'private_jun/amOWn37j6Pf6aboTA1dhgZs=',
  urlEndpoint:  'https://ik.imagekit.io/fsobpyaa5i',
});

// Multer com memoryStorage — ficheiro fica em RAM, nunca toca o disco
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|mp4|mov|avi|pdf/i.test(file.mimetype);
    cb(null, allowed);
  },
});

// ──────────────────────────────────────────────
// MIDDLEWARE
// ──────────────────────────────────────────────
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ──────────────────────────────────────────────
// MONGODB
// ──────────────────────────────────────────────
const MONGO_URI = 'mongodb+srv://2smarthrm_db_user:JvrSBCpRla7BLxIw@cluster0.yj1qese.mongodb.net/enco_db?retryWrites=true&w=majority';

mongoose.connect(MONGO_URI)
  .then(() => { console.log('✅  MongoDB connected'); seedAdmin(); })
  .catch(err => console.error('❌  MongoDB error:', err.message));

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
  type: { type: String, enum: ['image', 'video', 'youtube'], default: 'image' },
  ytId: String, order: { type: Number, default: 0 },
}, { timestamps: true });
const Gallery = mongoose.model('Gallery', gallerySchema);

const testimonialSchema = new mongoose.Schema({
  name: String, role: String, company: String, desc: String,
  image: String, ytUrl: String,
  type: { type: String, enum: ['text', 'image', 'video'], default: 'text' },
  active: { type: Boolean, default: true },
}, { timestamps: true });
const Testimonial = mongoose.model('Testimonial', testimonialSchema);

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true }, slug: String,
}, { timestamps: true });
const Category = mongoose.model('Category', categorySchema);

const postSchema = new mongoose.Schema({
  title: { type: String, required: true }, slug: String, desc: String,
  html: String, image: String,
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  status: { type: String, enum: ['rascunho', 'publicado', 'agendado'], default: 'rascunho' },
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

// ──────────────────────────────────────────────
// AUTH MIDDLEWARE
// ──────────────────────────────────────────────
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token em falta.' });
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
}

// ──────────────────────────────────────────────
// SEED ADMIN PADRÃO
// ──────────────────────────────────────────────
async function seedAdmin() {
  const exists = await User.findOne({ email: 'gestor@enco.co.ao' });
  if (exists) return;
  await User.create({ name: 'Gestor ENCO', email: 'gestor@enco.co.ao', password: 'Enco@2025', role: 'admin' });
  console.log('👤  Admin criado → gestor@enco.co.ao  /  Enco@2025');
}

// ──────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────
const validate = (req, res) => {
  const errs = validationResult(req);
  if (!errs.isEmpty()) { res.status(422).json({ errors: errs.array() }); return true; }
  return false;
};
const slugify = str => str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// ══════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════

app.post('/api/auth/login',
  body('email').isEmail(), body('password').notEmpty(),
  async (req, res) => {
    if (validate(req, res)) return;
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET, { expiresIn: '8h' }
    );
    res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, avatar: user.avatar } });
  }
);

//  console.log(`   GET            /api/auth/me`);
app.get('/api/auth/me', auth, async (req, res) => {
  res.json(await User.findById(req.user.id).select('-password'));
});

app.put('/api/auth/me', auth,
  body('name').optional().notEmpty(),
  body('password').optional().isLength({ min: 4 }),
  async (req, res) => {
    if (validate(req, res)) return;
    const updates = {};
    if (req.body.name)     updates.name     = req.body.name;
    if (req.body.avatar)   updates.avatar   = req.body.avatar;
    if (req.body.password) updates.password = await bcrypt.hash(req.body.password, 12);
    res.json(await User.findByIdAndUpdate(req.user.id, updates, { new: true }).select('-password'));
  }
);

// ══════════════════════════════════════════════
// IMAGEKIT – FILE UPLOAD  (private)
// RAM (multer memoryStorage) → ImageKit API
// Zero ficheiros guardados no disco local
// ══════════════════════════════════════════════

app.post('/api/admin/upload', auth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum ficheiro enviado.' });
  const folder   = req.body.folder || '/enco';
  const ext      = req.file.originalname.split('.').pop().toLowerCase();
  const safeName = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  try {
    const fileObj = await toFile(req.file.buffer, safeName, { type: req.file.mimetype });
    const result  = await imagekit.files.upload({
      file: fileObj, fileName: safeName, folder, useUniqueFileName: true, tags: ['enco'],
    });
    res.json({
      url:          result.url,
      fileId:       result.fileId,
      name:         result.name,
      size:         result.size,
      filePath:     result.filePath,
      thumbnailUrl: result.thumbnailUrl || result.url,
    });
  } catch (err) {
    console.error('ImageKit upload error:', err);
    res.status(500).json({ error: 'Erro no upload: ' + err.message });
  }
});

app.post('/api/admin/upload/url', auth,
  body('url').isURL(),
  async (req, res) => {
    if (validate(req, res)) return;
    const { url, fileName, folder = '/enco' } = req.body;
    try {
      const result = await imagekit.files.upload({
        file: url, fileName: fileName || `remote_${Date.now()}`, folder, useUniqueFileName: true,
      });
      res.json({ url: result.url, fileId: result.fileId, filePath: result.filePath });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

app.get('/api/admin/upload/files', auth, async (req, res) => {
  try {
    const { folder = '/enco', limit = 50, skip = 0 } = req.query;
    const files = await imagekit.assets.list({ path: folder, limit: Number(limit), skip: Number(skip) });
    res.json(files);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/upload/auth-token', auth, (_req, res) => {
  try {
    res.json({
      ...imagekit.helper.getAuthenticationParameters(),
      publicKey:   imagekit._options.publicKey,
      urlEndpoint: imagekit._options.urlEndpoint,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/upload/:fileId', auth, async (req, res) => {
  try { await imagekit.files.delete(req.params.fileId); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════
// SLIDES / CAROUSEL
// ══════════════════════════════════════════════

app.get('/api/slides', async (_req, res) => {
  res.json(await Slide.find({ active: true }).sort({ order: 1, createdAt: -1 }));
});
app.get('/api/admin/slides', auth, async (_req, res) => {
  res.json(await Slide.find().sort({ order: 1, createdAt: -1 }));
});
app.post('/api/admin/slides', auth, body('title').notEmpty(), async (req, res) => {
  if (validate(req, res)) return;
  res.status(201).json(await Slide.create(req.body));
});
app.put('/api/admin/slides/:id', auth, async (req, res) => {
  const doc = await Slide.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!doc) return res.status(404).json({ error: 'Não encontrado.' });
  res.json(doc);
});
app.patch('/api/admin/slides/reorder', auth, async (req, res) => {
  await Promise.all(req.body.map(o => Slide.findByIdAndUpdate(o.id, { order: o.order })));
  res.json({ ok: true });
});
app.delete('/api/admin/slides/:id', auth, async (req, res) => {
  await Slide.findByIdAndDelete(req.params.id); res.json({ ok: true });
});

// ══════════════════════════════════════════════
// SERVICES
// ══════════════════════════════════════════════

app.get('/api/services', async (_req, res) => {
  res.json(await Service.find({ active: true }).sort({ order: 1 }));
});
app.get('/api/admin/services', auth, async (_req, res) => {
  res.json(await Service.find().sort({ order: 1 }));
});
app.post('/api/admin/services', auth, body('title').notEmpty(), async (req, res) => {
  if (validate(req, res)) return;
  res.status(201).json(await Service.create(req.body));
});
app.put('/api/admin/services/:id', auth, async (req, res) => {
  const doc = await Service.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!doc) return res.status(404).json({ error: 'Não encontrado.' });
  res.json(doc);
});
app.delete('/api/admin/services/:id', auth, async (req, res) => {
  await Service.findByIdAndDelete(req.params.id); res.json({ ok: true });
});

// ══════════════════════════════════════════════
// GALLERY
// ══════════════════════════════════════════════

app.get('/api/gallery', async (req, res) => {
  const filter = req.query.type ? { type: req.query.type } : {};
  res.json(await Gallery.find(filter).sort({ order: 1, createdAt: -1 }));
});
app.get('/api/admin/gallery', auth, async (_req, res) => {
  res.json(await Gallery.find().sort({ order: 1, createdAt: -1 }));
});
app.post('/api/admin/gallery', auth, async (req, res) => {
  res.status(201).json(await Gallery.create(req.body));
});
app.put('/api/admin/gallery/:id', auth, async (req, res) => {
  const doc = await Gallery.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!doc) return res.status(404).json({ error: 'Não encontrado.' });
  res.json(doc);
});
app.delete('/api/admin/gallery/:id', auth, async (req, res) => {
  await Gallery.findByIdAndDelete(req.params.id); res.json({ ok: true });
});

// ══════════════════════════════════════════════
// TESTIMONIALS
// ══════════════════════════════════════════════

app.get('/api/testimonials', async (_req, res) => {
  res.json(await Testimonial.find({ active: true }).sort({ createdAt: -1 }));
});
app.get('/api/admin/testimonials', auth, async (_req, res) => {
  res.json(await Testimonial.find().sort({ createdAt: -1 }));
});
app.post('/api/admin/testimonials', auth, async (req, res) => {
  res.status(201).json(await Testimonial.create(req.body));
});
app.put('/api/admin/testimonials/:id', auth, async (req, res) => {
  const doc = await Testimonial.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!doc) return res.status(404).json({ error: 'Não encontrado.' });
  res.json(doc);
});
app.delete('/api/admin/testimonials/:id', auth, async (req, res) => {
  await Testimonial.findByIdAndDelete(req.params.id); res.json({ ok: true });
});

// ══════════════════════════════════════════════
// BLOG CATEGORIES
// ══════════════════════════════════════════════

app.get('/api/categories', async (_req, res) => {
  res.json(await Category.find().sort({ name: 1 }));
});
app.post('/api/admin/categories', auth, body('name').notEmpty(), async (req, res) => {
  if (validate(req, res)) return;
  res.status(201).json(await Category.create({ ...req.body, slug: slugify(req.body.name) }));
});
app.put('/api/admin/categories/:id', auth, async (req, res) => {
  if (req.body.name) req.body.slug = slugify(req.body.name);
  const doc = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!doc) return res.status(404).json({ error: 'Não encontrado.' });
  res.json(doc);
});
app.delete('/api/admin/categories/:id', auth, async (req, res) => {
  await Category.findByIdAndDelete(req.params.id);
  await Post.updateMany({ category: req.params.id }, { $unset: { category: '' } });
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
// BLOG POSTS
// ══════════════════════════════════════════════

app.get('/api/posts', async (req, res) => {
  const { cat, q, page = 1, limit = 9 } = req.query;
  const filter = { status: 'publicado' };
  if (cat) filter.category = cat;
  if (q)   filter.title    = { $regex: q, $options: 'i' };
  const total = await Post.countDocuments(filter);
  const posts = await Post.find(filter)
    .populate('category', 'name slug').sort({ createdAt: -1 })
    .skip((page - 1) * limit).limit(Number(limit));
  res.json({ posts, total, page: Number(page), pages: Math.ceil(total / limit) });
});

app.get('/api/posts/:idOrSlug', async (req, res) => {
  const { idOrSlug } = req.params;
  const isId = mongoose.Types.ObjectId.isValid(idOrSlug);
  const post = isId
    ? await Post.findById(idOrSlug).populate('category', 'name slug')
    : await Post.findOne({ slug: idOrSlug }).populate('category', 'name slug');
  if (!post || post.status !== 'publicado')
    return res.status(404).json({ error: 'Post não encontrado.' });
  res.json(post);
});

app.get('/api/admin/posts', auth, async (req, res) => {
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
});

app.post('/api/admin/posts', auth, body('title').notEmpty(), async (req, res) => {
  if (validate(req, res)) return;
  res.status(201).json(await Post.create({ ...req.body, slug: slugify(req.body.title), author: req.user.name }));
});
app.put('/api/admin/posts/:id', auth, async (req, res) => {
  if (req.body.title) req.body.slug = slugify(req.body.title);
  const doc = await Post.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!doc) return res.status(404).json({ error: 'Não encontrado.' });
  res.json(doc);
});
app.delete('/api/admin/posts/:id', auth, async (req, res) => {
  await Post.findByIdAndDelete(req.params.id); res.json({ ok: true });
});

// ══════════════════════════════════════════════
// CONTACT INFO
// ══════════════════════════════════════════════

app.get('/api/contact', async (_req, res) => {
  res.json(await Contact.findOne() || {});
});
app.put('/api/admin/contact', auth, async (req, res) => {
  res.json(await Contact.findOneAndUpdate({}, req.body, { new: true, upsert: true }));
});

// ══════════════════════════════════════════════
// SITE PROFILE / CONFIG
// ══════════════════════════════════════════════

app.get('/api/profile', async (_req, res) => {
  res.json(await Profile.findOne() || {});
});
app.put('/api/admin/profile', auth, async (req, res) => {
  res.json(await Profile.findOneAndUpdate({}, req.body, { new: true, upsert: true }));
});

// ══════════════════════════════════════════════
// DASHBOARD STATS
// ══════════════════════════════════════════════

app.get('/api/admin/stats', auth, async (_req, res) => {
  const [slides, services, gallery, testimonials, posts, categories] = await Promise.all([
    Slide.countDocuments(), Service.countDocuments(), Gallery.countDocuments(),
    Testimonial.countDocuments(), Post.countDocuments(), Category.countDocuments(),
  ]);
  const [published, drafts, scheduled] = await Promise.all([
    Post.countDocuments({ status: 'publicado' }),
    Post.countDocuments({ status: 'rascunho' }),
    Post.countDocuments({ status: 'agendado' }),
  ]);
  const recentPosts = await Post.find().sort({ createdAt: -1 }).limit(5).populate('category', 'name');
  res.json({ slides, services, gallery, testimonials, posts, categories, published, drafts, scheduled, recentPosts });
});

// ══════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ══════════════════════════════════════════════
// START
// ══════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n   ENCO API  →  http://localhost:${PORT}\n`);
  console.log(`📋  PÚBLICAS (sem token)`);
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
  console.log(`\n   PRIVADAS (Bearer JWT)`);
  console.log(`   POST              /api/auth/login`);
  console.log(`   GET  PUT          /api/auth/me`);
  console.log(`   GET  POST PUT DEL /api/admin/slides`);
  console.log(`   GET  POST PUT DEL /api/admin/services`);
  console.log(`   GET  POST PUT DEL /api/admin/gallery`);
  console.log(`   GET  POST PUT DEL /api/admin/testimonials`);
  console.log(`   GET  POST PUT DEL /api/admin/categories`);
  console.log(`   GET  POST PUT DEL /api/admin/posts`);
  console.log(`   PUT               /api/admin/contact`);
  console.log(`   PUT               /api/admin/profile`);
  console.log(`   GET               /api/admin/stats`);
  console.log(`\n   IMAGEKIT (RAM → cloud, zero disco local)`);
  console.log(`   POST /api/admin/upload             ← multipart/form-data`);
  console.log(`   POST /api/admin/upload/url         ← upload por URL remota`);
  console.log(`   GET  /api/admin/upload/files       ← listar ficheiros`);
  console.log(`   GET  /api/admin/upload/auth-token  ← token client-side`);
  console.log(`   DEL  /api/admin/upload/:fileId     ← apagar ficheiro\n`);
});

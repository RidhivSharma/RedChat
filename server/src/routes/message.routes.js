import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { deleteMessage } from '../controllers/message.controller.js';

const router = Router();

router.use(requireAuth);

router.delete('/:id', deleteMessage);

export default router;

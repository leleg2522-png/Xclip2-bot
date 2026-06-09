import { Router, type IRouter } from "express";
import healthRouter from "./health";
import picsartRouter from "./picsart";

const router: IRouter = Router();

router.use(healthRouter);
router.use(picsartRouter);

export default router;

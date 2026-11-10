import { runCard } from '../run-card.ts';
import { INITIAL, present, step } from './model.ts';

runCard('chickpea-connect-card', { initial: INITIAL, step, present });

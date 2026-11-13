-- Reasoning effort per agent (#131): low, medium, high, xhigh or max; empty uses the model's default.
ALTER TABLE agents ADD COLUMN effort TEXT NOT NULL DEFAULT '';

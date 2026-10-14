'use strict';

const { z } = require('zod');

/**
 * Path params for the operational read APIs. Patterns mirror the CHECK
 * constraints on the corresponding tables so a malformed id is a 400, not a DB
 * round-trip.
 */
const idPattern = /^[A-Za-z0-9_-]{1,64}$/;

const machineIdParamSchema = z.string().regex(idPattern, 'invalid machine_id');
const plantIdParamSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'invalid plant_id');
const lineIdParamSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'invalid line_id');

module.exports = { machineIdParamSchema, plantIdParamSchema, lineIdParamSchema };

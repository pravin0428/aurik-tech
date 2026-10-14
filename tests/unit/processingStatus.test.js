'use strict';

const {
  submissionStatusForJob,
  SUBMISSION_STATUS_BY_JOB_STATUS,
} = require('../../src/modules/processing/status');

describe('submissionStatusForJob', () => {
  test('maps each job state to the matching submission state', () => {
    expect(submissionStatusForJob('pending')).toBe('pending');
    expect(submissionStatusForJob('processing')).toBe('processing');
    expect(submissionStatusForJob('retrying')).toBe('retrying');
    expect(submissionStatusForJob('succeeded')).toBe('succeeded');
    expect(submissionStatusForJob('dead_letter')).toBe('dead_letter');
    expect(submissionStatusForJob('blocked')).toBe('blocked');
  });

  test('every mapping is defined', () => {
    for (const value of Object.values(SUBMISSION_STATUS_BY_JOB_STATUS)) {
      expect(typeof value).toBe('string');
    }
  });

  test('never maps a non-success job state to succeeded', () => {
    for (const [jobStatus, submissionStatus] of Object.entries(
      SUBMISSION_STATUS_BY_JOB_STATUS
    )) {
      if (jobStatus !== 'succeeded') {
        expect(submissionStatus).not.toBe('succeeded');
      }
    }
  });

  test('throws for an unknown job status', () => {
    expect(() => submissionStatusForJob('mystery')).toThrow(/No submission status/);
  });
});

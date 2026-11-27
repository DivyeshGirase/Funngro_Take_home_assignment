// Part 2 reporting only; no reward writes or changes to the Part 1 API.
function monthlyUserStages({ start, end, cohortId } = {}) {
  if (!(start instanceof Date) || !(end instanceof Date) ||
      !Number.isFinite(+start) || !Number.isFinite(+end) || start >= end) {
    throw new Error('Valid start/end Dates required, with start before end');
  }
  if (cohortId !== undefined && (typeof cohortId !== 'string' || !cohortId.length)) {
    throw new Error('cohortId must be a nonempty string');
  }
  const total = type => ({
    $sum: { $cond: [{ $eq: ['$type', type] }, { $toDecimal: '$points' }, { $toDecimal: 0 }] }
  });
  return [
    { $match: {
      occurredAt: { $gte: start, $lt: end },
      ...(cohortId !== undefined ? { cohortId } : {})
    } },
    { $group: {
      _id: { cohortId: '$cohortId', userId: '$userId' },
      pointsEarned: total('earned'),
      pointsConverted: total('converted'),
      pointsExpired: total('expired')
    } },
    { $project: {
      _id: 0, cohortId: '$_id.cohortId', userId: '$_id.userId',
      pointsEarned: 1, pointsConverted: 1, pointsExpired: 1
    } }
  ];
}

function monthlyPointsPipeline(options) {
  return [...monthlyUserStages(options), { $sort: { cohortId: 1, userId: 1 } }];
}

function monthlyCohortPipeline(options) {
  return [...monthlyUserStages(options),
    { $group: {
      _id: '$cohortId', activeUsers: { $sum: 1 },
      pointsEarned: { $sum: '$pointsEarned' },
      pointsConverted: { $sum: '$pointsConverted' },
      pointsExpired: { $sum: '$pointsExpired' }
    } },
    { $project: {
      _id: 0, cohortId: '$_id', activeUsers: 1,
      pointsEarned: 1, pointsConverted: 1, pointsExpired: 1
    } },
    { $sort: { cohortId: 1 } }
  ];
}

module.exports = { monthlyPointsPipeline, monthlyCohortPipeline };

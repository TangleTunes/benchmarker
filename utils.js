function result_to_obj(res, keys) {
	obj = {}
	res.map((e, i) => obj[keys[i]] = e)
	return obj
}

function range(size, startAt) {
    return [...Array(size).keys()].map(i => i + startAt);
}

function getRandomInt(max) {
	return Math.floor(Math.random() * max);
}

module.exports = {
	result_to_obj,
	getRandomInt,
	range
}
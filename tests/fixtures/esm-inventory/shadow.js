// 夹具：局部同名遮蔽（参数 shadow 门面名）
const MaweHint = { local: true };
export function probe(MaweDom) { return MaweHint.local + MaweDom.x; }

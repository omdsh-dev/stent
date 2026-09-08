console.log(JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),activation:globalThis[Symbol.for("oh-my-dsh.stent.activation")] === true}))

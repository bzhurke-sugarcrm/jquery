/**
 * Special build task to handle various jQuery build requirements.
 * Compiles JS modules into one bundle, sets the custom AMD name,
 * and includes/excludes specified modules
 */

"use strict";

const fs = require( "fs" );
const path = require( "path" );
const util = require( "util" );
const exec = util.promisify( require( "child_process" ).exec );
const requirejs = require( "requirejs" );
const excludedFromSlim = require( "./lib/slim-exclude" );
const pkg = require( "../../package.json" );
const isCleanWorkingDir = require( "./lib/isCleanWorkingDir" );
const minify = require( "./minify" );
const getTimestamp = require( "./lib/getTimestamp" );
const verifyNodeVersion = require( "./lib/verifyNodeVersion" );
const srcFolder = path.resolve( __dirname, "../../src" );

const rdefineEnd = /\}\s*?\);[^}\w]*$/;

const minimum = [ "core" ];

// Exclude specified modules if the module matching the key is removed
const removeWith = {
	ajax: [ "manipulation/_evalUrl", "deprecated/ajax-event-alias" ],
	callbacks: [ "deferred" ],
	css: [ "effects", "dimensions", "offset" ],
	"css/showHide": [ "effects" ],
	deferred: {
		remove: [ "ajax", "effects", "queue", "core/ready" ],
		include: [ "core/ready-no-deferred" ]
	},
	event: [ "deprecated/ajax-event-alias", "deprecated/event" ],
	selector: [ "css/hiddenVisibleSelectors", "effects/animatedSelector" ]
};

async function read( filename ) {
	return fs.promises.readFile( path.join( srcFolder, filename ), "utf8" );
}

// Remove the src folder and file extension
// and ensure unix-style path separators
function moduleName( filename ) {
	return filename
		.replace( `${ srcFolder }${ path.sep }`, "" )
		.replace( /\.js$/, "" )
		.split( path.sep )
		.join( path.posix.sep );
}

async function readdirRecursive( dir, all = [] ) {
	let files;
	try {
		files = await fs.promises.readdir( path.join( srcFolder, dir ), {
			withFileTypes: true
		} );
	} catch ( e ) {
		return all;
	}
	for ( const file of files ) {
		const filepath = path.join( dir, file.name );

		if ( file.isDirectory() ) {
			all.push( ...( await readdirRecursive( filepath ) ) );
		} else {
			all.push( moduleName( filepath ) );
		}
	}
	return all;
}

async function getRequireConfig( { amd } = {} ) {
	const wrapperSource = await read( "wrapper.js" );

	// Catch `// @CODE` and subsequent comment lines event if they don't start
	// in the first column.
	const wrapper = wrapperSource.split(
		/[\x20\t]*\/\/ @CODE\n(?:[\x20\t]*\/\/[^\n]+\n)*/
	);

	/**
	 * Strip all definitions generated by requirejs
	 * Convert "var" modules to var declarations
	 * "var module" means the module only contains a return
	 * statement that should be converted to a var declaration
	 * This is indicated by including the file in any "var" folder
	 * @param {String} name
	 * @param {String} path
	 * @param {String} contents The contents to be written (including their AMD wrappers)
	 */
	function convert( name, path, contents ) {

		// Convert var modules
		if ( /.\/var\//.test( path.replace( process.cwd(), "" ) ) ) {
			contents = contents
				.replace(
					/define\(\s*(["'])[\w\W]*?\1[\w\W]*?return/,
					"var " +
					( /var\/([\w-]+)/.exec( name )[ 1 ] ) +
					" ="
				)
				.replace( rdefineEnd, "" );

		} else {

			contents = contents
				.replace( /\s*return\s+[^\}]+(\}\s*?\);[^\w\}]*)$/, "$1" )

				// Multiple exports
				.replace( /\s*exports\.\w+\s*=\s*\w+;/g, "" );

			// Remove define wrappers, closure ends, and empty declarations
			contents = contents
				.replace( /define\([^{]*?{\s*(?:("|')use strict\1(?:;|))?/, "" )
				.replace( rdefineEnd, "" );

			// Remove anything wrapped with
			// /* ExcludeStart */ /* ExcludeEnd */
			// or a single line directly after a // BuildExclude comment
			contents = contents
				.replace( /\/\*\s*ExcludeStart\s*\*\/[\w\W]*?\/\*\s*ExcludeEnd\s*\*\//ig, "" )
				.replace( /\/\/\s*BuildExclude\n\r?[\w\W]*?\n\r?/ig, "" );

			// Remove empty definitions
			contents = contents
				.replace( /define\(\s*\[[^\]]*\]\s*\)[\W\n]+$/, "" );
		}

		// AMD Name
		if ( amd != null && /^exports\/amd$/.test( name ) ) {
			if ( amd ) {
				console.log( "Naming jQuery with AMD name: " + amd );
			} else {
				console.log( "AMD name now anonymous" );
			}

			// Remove the comma for anonymous defines
			contents = contents
				.replace( /(\s*)"jquery"(\,\s*)/, amd ? "$1\"" + amd + "\"$2" : "" );

		}
		return contents;
	}

	return {
		baseUrl: "src",
		name: "jquery",

		// Allow strict mode
		useStrict: true,

		// We have multiple minify steps
		optimize: "none",

		// Include dependencies loaded with require
		findNestedDependencies: true,

		// Avoid inserting define() placeholder
		skipModuleInsertion: true,

		// Avoid breaking semicolons inserted by r.js
		skipSemiColonInsertion: true,
		wrap: {
			start: wrapper[ 0 ].replace( /\/\*\s*eslint(?: |-).*\s*\*\/\n/, "" ),
			end: wrapper[ 1 ]
		},
		rawText: {},
		onBuildWrite: convert
	};
}

function unique( array ) {
	return [ ...new Set( array ) ];
}

async function checkExclude( exclude, include ) {
	const included = [ ...include ];
	const excluded = [ ...exclude ];

	for ( const module of exclude ) {
		if ( minimum.indexOf( module ) !== -1 ) {
			throw new Error( `Module \"${ module }\" is a minimum requirement.` );
		}

		// Exclude all files in the dir of the same name
		// These are the removable dependencies
		// It's fine if the directory is not there
		// `selector` is a special case as we don't just remove
		// the module, but we replace it with `selector-native`
		// which re-uses parts of the `src/selector` folder.
		// "sizzle" is legacy for selector
		if ( module !== "selector" && module !== "sizzle" ) {
			const files = await readdirRecursive( module );
			excluded.push( ...files );
		}

		// Check removeWith list
		const additional = removeWith[ module ];
		if ( additional ) {
			const [ additionalExcluded, additionalIncluded ] = await checkExclude(
				additional.remove || additional,
				additional.include || []
			);
			excluded.push( ...additionalExcluded );
			included.push( ...additionalIncluded );
		}
	}

	return [ unique( excluded ), unique( included ) ];
}

async function build( {
	amd,
	dir = "dist",
	exclude = [],
	filename = "jquery.js",
	include = [],
	slim = false,
	version
} = {} ) {

	// Add the short commit hash to the version string
	// when the version is not for a release.
	if ( !version ) {
		const { stdout } = await exec( "git rev-parse --short HEAD" );
		const isClean = await isCleanWorkingDir();

		// Add "+SHA" if the version is not set.
		// Add ".dirty" as well if the working dir is not clean.
		version = `${ pkg.version }+${ stdout.trim() }${ isClean ? "" : ".dirty" }`;
	}

	await fs.promises.mkdir( dir, { recursive: true } );

	// Exclude slim modules when slim is true
	const [ excluded, included ] = await checkExclude(
		slim ? exclude.concat( excludedFromSlim ) : exclude,
		include
	);
	const config = await getRequireConfig( { amd } );

	// Replace exports/global with a noop noConflict
	if ( excluded.includes( "exports/global" ) ) {
		const index = excluded.indexOf( "exports/global" );
		config.rawText[ "exports/global" ] = "define( [\n\t\"../core\"\n], " +
			"function( jQuery ) {\n\tjQuery.noConflict = function() {};\n} );";
		excluded.splice( index, 1 );
	}

	// "sizzle" is legacy for selector
	if ( excluded.indexOf( "selector" ) > -1 || excluded.indexOf( "sizzle" ) > -1 ) {
		config.rawText.selector = "define( [ \"./selector-native\" ] );";
	}

	if ( excluded.length ) {

		// Append excluded modules to version.
		// Skip adding exclusions for slim builds.
		// Don't worry about semver syntax for these.
		if ( excluded.length ) {
			version += " -" + excluded.join( ",-" );
		}

		// Have to use shallow or core will get excluded since it is a dependency
		config.excludeShallow = excluded;
	}

	if ( included.length ) {
		config.include = included;

		// Append extra included modules to version.
		if ( included.length ) {
			version += " +" + included.join( ",+" );
		}

		// Overwrite the default inclusions with the explicit ones provided
		config.rawText.jquery = "define( [\n" +
			included.map( module => "\t\"./" + module + "\"" ).join( ",\n" ) +
		"\n] );";
	}

	/**
	 * Handle Final output from the optimizer
	 * @param {String} compiled
	 */
	config.out = async function( compiled ) {
		const compiledContents = compiled

			// Embed Version
			.replace( /@VERSION/g, version )

			// Embed Date
			// yyyy-mm-ddThh:mmZ
			.replace( /@DATE/g, new Date().toISOString().replace( /:\d+\.\d+Z$/, "Z" ) );

		// Write concatenated source to file
		await fs.promises.writeFile(
			path.join( dir, filename ),
			compiledContents
		);
	};

	await new Promise( ( resolve, reject ) => {
		requirejs.optimize( config, () => {

			// Wait a beat. For some reason, the write can
			// take a moment after this to complete in Node 10.
			setTimeout( resolve, 100 );
		}, ( error ) => {
			console.error( error );
			reject( error );
		} );
	} );

	console.log( `[${ getTimestamp() }] ${ filename } v${ version } created.` );

	await minify( { filename, dir } );
}

async function buildDefaultFiles( { version } = {} ) {
	await Promise.all( [
		build( { version } ),
		build( { filename: "jquery.slim.js", slim: true, version } )
	] );

	// Earlier Node.js versions do not support the ESM format.
	if ( !verifyNodeVersion() ) {
		return;
	}

	const { compareSize } = await import( "./compare_size.mjs" );
	return compareSize( {
		files: [
			"dist/jquery.min.js",
			"dist/jquery.slim.min.js"
		]
	} );
}

module.exports = { build, buildDefaultFiles };

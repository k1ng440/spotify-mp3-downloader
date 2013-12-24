var config = {
	username:	'',
	password:	'',
	port:		1717
}

process.on('uncaughtException', function (err) {
	
	console.log(err.stack);
	
	if( err.toString().indexOf('Track is not playable in country') > -1 ) { // skip track
	
		console.log(err.toString() + ': ' + current_track);
	
		socket.emit('error', {
			id: current_track,
			err: err.toString()
		});
	
		tracks_done.push( current_track );
		waitForSpotify();
	} else if( err.code == 8 ) { // Rate limited
		waitForSpotify();
	}
});

// generate modules folder, OS specific
var modules_folder = __dirname + '/node_modules';
if( require('os').platform() == 'win32' ) {
	if( require('os').arch() == 'ia32' ) {
		modules_folder = modules_folder + '.win32.ia32'
	} else if( require('os').arch() == 'x64' ){
		modules_folder = modules_folder + '.win32.x64'
	}
} else if( require('os').platform() == 'darwin' ) {
	if( require('os').arch() == 'x64' ){
		modules_folder = modules_folder + '.darwin.x64'
	}
}

modules_folder = modules_folder + '/';

if( modules_folder == __dirname + '/node_modules/' ) {
	console.log('Unsupported OS + architecture. Please run the following commands manually and re-run:');
	console.log('npm install async');
	console.log('npm install express');
	console.log('npm install socket.io');
	console.log('npm install spotify-web');
	console.log('With your architecture, the ID3 tagging may or may not work! Please be sure the command `id3tag` is working.');
	
}

var fs = require('fs');
var async = require(modules_folder + 'async');
var express = require(modules_folder + 'express')
var app = express();
var server = require('http').createServer(app);
var io = require(modules_folder + 'socket.io').listen(server, { log: false });
var spotify_web = require(modules_folder + 'spotify-web');
var socket = socket;
var current_track = {};
var tracks = [];
var tracks_done = [];
var playlist_id = false;
var playlist_folder = false;

var waitForSpotify = function(){
	console.log('waitForSpotify');
	
	// remove tracks already done
	for( var i = 0; i < tracks.length; i++ ) {
		for( var j = 0; j < tracks_done.length; j++ ) {
			if( tracks[i].id == tracks_done[j] ) {
				tracks.splice(i, 1)
			}
		}
	}
		
	console.log('Waiting 1s...');
	setTimeout(function(){
		console.log('Trying again!');
		downloadTracks( tracks );
	}, 1000);
}

app.use( '/', express.static( __dirname + '/www/') );

server.listen(config.port);

console.log('Server running, to use, open http://localhost:' + config.port + ' in your browser.');

if( require('os').platform() == 'win32' ) {
	require('child_process').exec('start http://localhost:' + config.port + '');
} else {
	require('child_process').exec('open "http://localhost:' + config.port + '"');
}

io.sockets.on('connection', function (socket_) {
	socket = socket_;
	
	if( config.username != '' && config.password != '' ) {
		socket.emit('logged-in');
	}
	
	socket.on('go', function (result) {	
		current_track = {};
		tracks = [];
		tracks_done = [];
		playlist_id = false;
		playlist_folder = false;
		
		downloadTracks( result.tracks );		
	});
	socket.on('login', function (result, callback) {
		
		spotify_web.login(result.username, result.password, function(err, spotify) {
		
			var success = false;
			var message = 'Invalid username/password!';
		
			if( typeof spotify != 'undefined' ) {
				if( spotify.accountType == 'premium' ) {
					config.username = result.username;
					config.password = result.password;	
					success = true;	
				} else {
					message = 'You need a Premium subscribtion!';
				}
			}
			
			if( typeof callback == 'function' ){
				callback({
					success: success,
					message: message
				});
			}
		});
	});
});

var downloadTracks = function(tracks_) {
	
	// check if playlist. if so, fill the tracks object with the playlist contents
	// only 1 playlist download at the time
	if( tracks_[0].title.indexOf('/playlist/') > 0 ) {
		var uri = tracks_[0].title;
		uri = uri.replace('http://open.spotify.com/', 'spotify:');
		uri = uri.replace(/\//g, ':');
						
		downloadPlaylist( uri );
	} else {
		tracks = tracks_;
	}
	
	async.eachSeries(tracks, function (track, callback) {
		downloadTrack( 'spotify:track:' + track.id, callback );
	}, function (err) {
		if (err) { console.log(err); }
		console.log('All done!');
		
		if( playlist_id && playlist_folder ) {	
			socket.emit('done', {
				id: playlist_id,
				filepath: __dirname + '/mp3/' + playlist_folder
			});					
		}
		
		tracks_done = [];
	});	
}

var downloadPlaylist = function( uri ) {
		
	// generate id
	var id = uri.split(':');
    	id = id[ id.length-1 ];
    	
    playlist_id = id;
	    	
	spotify_web.login(config.username, config.password, function (err, spotify) {
	    	
		if (err) {
			socket.emit('error', {
				id: id
			});
			return false;
		}
		
		spotify.playlist( uri, 0, 99999, function(err, result){
			if (err) {
				socket.emit('error', {
					id: id
				});
				return false;
			}
			
			playlist_folder = result.attributes.name;
			
			for( var i = 0; i < result.contents.items.length; i++ ) {
				tracks.push({
					title: '',
					id: result.contents.items[i].uri.replace('spotify:track:', '')
				});
			}
			
			downloadTracks( tracks );
		});
	});
}

var downloadTrack = function( uri, callback ){
				
	// generate id
	var id = uri.split(':');
    	id = id[ id.length-1 ]; 
	
	current_track = id;
	
	socket.emit('busy', {
		id: ( playlist_id ) ? playlist_id : id
	});
	
	spotify_web.login(config.username, config.password, function (err, spotify) {
		if (err) {
			console.log(err);
			socket.emit('error', {
				id: id
			});
			return false;
		}
	
		// first get a "Track" instance from the track URI
		spotify.get(uri, function (err, track) {
			if (err) {
				console.log(err);
				socket.emit('error', {
					id: id
				});
				return false;
			}
			
			// generate artists, seperate multiple by slash (/)
			var artists = [];
			for( var i = 0; i < track.artist.length; i++ ) {
				artists.push(track.artist[i].name);
			}
			artists = artists.join(' / ');
			
			if( playlist_folder ) {
				var albumpath = __dirname + '/mp3/' + fixTrackName(playlist_folder) + '/';
								
				// generate folder if it does not exist
				if( !fs.existsSync(albumpath) ) {
					fs.mkdir( albumpath );
				}
				
			} else {			
				// generate the artist path
				var artistpath = __dirname + '/mp3/' + fixTrackName(track.artist[0].name) + '/';
								
				// generate folder if it does not exist
				if( !fs.existsSync(artistpath) ) {
					fs.mkdir( artistpath );
				}
				
				// generate the albumpath
				var albumpath = artistpath + fixTrackName(track.album.name) + ' [' + track.album.date.year + ']/';
								
				// generate folder if it does not exist
				if( !fs.existsSync(albumpath) ) {
					fs.mkdir( albumpath );
				}
			}				
			
			// generate the filepath
			var filepath = albumpath + fixTrackName(track.artist[0].name) + ' - ' + fixTrackName(track.name) + '.mp3';
	
			// create filestream for the .mp3
			var out = fs.createWriteStream( filepath );
	
			// play() returns a readable stream of MP3 audio data	
			track.play().pipe(out).on('finish', function () {
				console.log('-----------------------------------------');
				console.log('Downloaded: %s - %s', track.artist[0].name, track.name);
				//spotify.disconnect();
				
				// tag the file
				if( require('os').platform() == 'win32' ) {
					require('child_process').exec( __dirname + '/bin/id3tag.exe -a "' + artists + '" -l "' + track.album.name + '" -t "' + track.name + '" -y "' + track.album.date.year + '" -n "' + track.number + '" -c "Track downloaded from Spotify: ' + uri + '" "' + filepath + '"');
				} else {			
					require('child_process').exec('id3tag --artist="' + artists + '" --album="' + track.album.name + '" --song="' + track.name + '" --year="' + track.album.date.year + '" --track="' + track.number + '" --comment="Track downloaded from Spotify: ' + uri + '" "' + filepath + '"');
				}
				console.log('ID3\'d: %s - %s', track.artist[0].name, track.name);
				
				if( !playlist_id ) {			
					socket.emit('done', {
						id: id,
						filepath: filepath
					});
				}
				
				tracks_done.push( id );
				
				if( typeof callback == 'function' ) {
					callback();
				}
				
			});
	
		});
	});
}

var fixTrackName = function( input ) {
	var regEx = new RegExp('[,/\:*?""<>|]', 'g');
	return input.replace(regEx, '_');
}
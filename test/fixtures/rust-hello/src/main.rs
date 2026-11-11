use std::io::{Read, Write};
use std::net::TcpListener;

fn main() {
    let port = std::env::var("PORT").expect("PORT");
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("bind");
    for stream in listener.incoming().flatten() {
        let mut stream = stream;
        let mut buf = [0u8; 1024];
        let _ = stream.read(&mut buf);
        let body = "hello from rust\n";
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            body.len(),
            body
        );
    }
}

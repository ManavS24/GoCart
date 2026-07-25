'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import Title from './Title'

const Newsletter = () => {

    const [email, setEmail] = useState('')

    const handleSubscribe = (e) => {
        e.preventDefault()
        setEmail('')
        toast.success('Thanks for subscribing!')
    }

    return (
        <div className='flex flex-col items-center mx-4 my-36'>
            <Title title="Join Newsletter" description="Subscribe to get exclusive deals, new arrivals, and insider updates delivered straight to your inbox every week." visibleButton={false} />
            <form onSubmit={handleSubscribe} className='flex bg-slate-100 text-sm p-1 rounded-full w-full max-w-xl my-10 border-2 border-white ring ring-slate-200'>
                <input value={email} onChange={(e) => setEmail(e.target.value)} className='flex-1 pl-5 outline-none bg-transparent' type="email" placeholder='Enter your email address' required />
                <button type="submit" className='font-medium bg-green-500 text-white px-7 py-3 rounded-full hover:scale-103 active:scale-95 transition'>Get Updates</button>
            </form>
        </div>
    )
}

export default Newsletter
